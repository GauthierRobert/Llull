/**
 * @layer ui/viewport/3d
 * 3D perspective viewport: one r3f <Canvas frameloop="demand"> repainted by the store
 * invalidators. Quality tier (useRenderQuality) scales shadows/environment to the entity count.
 * Entities + gizmo sit in a group offset by -renderOrigin (float32-safe floating origin).
 * Presentational only: changes go through dispatch.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureBvhSetup } from './bvhSetup';

// Engage BVH prototype patch once at module load — idempotent, safe under StrictMode.
ensureBvhSetup();
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
  PerspectiveCamera,
  Environment,
  Lightformer,
  ContactShadows,
  SoftShadows,
} from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { useToolStore, useViewportStore } from '@ui/store';
import { Entities } from './Entities';
import { TransformGizmo } from './TransformGizmo';
import { RenderOriginSyncer } from '../RenderOriginSyncer';
import type { GizmoMode } from '@ui/store';
import { ViewPresetsInner, ViewPresetsOverlay } from './ViewPresets';
import { NamedViewsInner } from './NamedViews';
import { MeasureBBoxWireframe } from './MeasureBBoxWireframe';
import { ClippingPlane } from './ClippingPlane';
import { ViewportControls } from './ViewportControls';
import { AnimationPlayer } from './AnimationPlayer';
import { useRenderQuality } from './useRenderQuality';
import { MechanismOverlay } from './MechanismOverlay';
import { useViewportPalette } from '@ui/viewport/viewportPalette';
import { StoreInvalidator } from '../StoreInvalidator';

/**
 * Subscribes to the viewport store (displayMode, clipPlane, hiddenEntityIds)
 * and calls r3f invalidate() on any change so the Canvas repaints under
 * frameloop="demand". Pattern mirrors StoreInvalidator above.
 */
function ViewportStoreInvalidator(): null {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    let prevMode = useViewportStore.getState().displayMode;
    let prevClip = useViewportStore.getState().clipPlane;
    let prevHidden = useViewportStore.getState().hiddenEntityIds;
    let prevQuality = useViewportStore.getState().qualityOverride;

    return useViewportStore.subscribe((state) => {
      if (
        state.displayMode !== prevMode ||
        state.clipPlane !== prevClip ||
        state.hiddenEntityIds !== prevHidden ||
        state.qualityOverride !== prevQuality
      ) {
        prevMode = state.displayMode;
        prevClip = state.clipPlane;
        prevHidden = state.hiddenEntityIds;
        prevQuality = state.qualityOverride;
        invalidate();
      }
    });
  }, [invalidate]);

  return null;
}

/** drei Grid/ContactShadows lie in the Y-up XZ plane; rotate them into the +Z-up XY ground plane. */
const GROUND_PLANE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];

/**
 * Convert spherical CameraState → a cartesian THREE.Vector3 eye position.
 *
 * +Z-up right-handed convention:
 *   polar=0   → camera directly above the target along +Z
 *   polar=π/2 → camera in the XY plane (at target elevation)
 *   azimuth   → angle in the XY plane from +Y axis toward +X
 */
function sphericalToCartesian(
  target: [number, number, number],
  azimuth: number,
  polar: number,
  distance: number,
): [number, number, number] {
  const sinPolar = Math.sin(polar);
  return [
    target[0] + distance * sinPolar * Math.sin(azimuth),
    target[1] + distance * sinPolar * Math.cos(azimuth),
    target[2] + distance * Math.cos(polar),
  ];
}

/**
 * Reacts to `document.camera` changes written by commands (`set_camera`, `fit_view`)
 * and imperatively updates the PerspectiveCamera + OrbitControls to match.
 *
 * Pattern (R6): useEffect syncs an external object (three.js camera/controls) to
 * React state. Does NOT push drag-orbit updates back to the store — orbit/zoom
 * are presentation-only (architecture L4; PRIME DIRECTIVE).
 *
 * Feedback-loop guard: the effect compares the incoming CameraState value against
 * what the live camera currently shows (target + azimuth/polar/distance computed
 * from the camera position). Only applies when the selector produces a new object
 * reference (Zustand shallow equality keeps this stable through re-renders caused
 * by unrelated store slices).
 *
 * Must be mounted inside the Canvas so useThree resolves.
 */
function CameraReactor(): null {
  const { camera, controls, invalidate } = useThree();
  // Narrow selector: only subscribe to the camera slice (R3).
  const docCamera = useStore((s) => s.document.camera);

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;
    if (!orbit) return;

    // The camera lives in render space (world − renderOrigin), like the entity group.
    const [ox, oy, oz] = useStore.getState().renderOrigin;
    const newPos = sphericalToCartesian(
      docCamera.target as [number, number, number],
      docCamera.azimuth,
      docCamera.polar,
      docCamera.distance,
    );

    camera.position.set(newPos[0] - ox, newPos[1] - oy, newPos[2] - oz);
    orbit.target.set(docCamera.target[0] - ox, docCamera.target[1] - oy, docCamera.target[2] - oz);

    // Sync OrbitControls internal spherical state to new position/target.
    orbit.update();
    // Queue a render frame (demand frameloop).
    invalidate();
  }, [docCamera, camera, controls, invalidate]);

  return null;
}

/**
 * Keeps depth precision usable from millimetre parts to building-scale models (1e4–1e5 units in
 * mm): near/far track the camera→target distance at a fixed 1:4e6 ratio. Updates the projection
 * only when the distance changed by more than 10 %.
 */
function AdaptiveClipping(): null {
  const { camera, controls } = useThree();
  const lastDistance = useRef(0);
  useFrame(() => {
    const target = (controls as OrbitControlsImpl | null)?.target;
    if (!target) return;
    const distance = camera.position.distanceTo(target);
    if (Math.abs(distance - lastDistance.current) <= lastDistance.current * 0.1) return;
    lastDistance.current = distance;
    const perspective = camera as THREE.PerspectiveCamera;
    perspective.near = Math.max(distance / 2000, 1e-3);
    perspective.far = Math.max(distance * 2000, 1e3);
    perspective.updateProjectionMatrix();
  });
  return null;
}

interface SceneContentsProps {
  /** When false, OrbitControls is disabled (gizmo drag in progress). */
  orbitEnabled: boolean;
  gizmoMode: GizmoMode;
  onDraggingChanged: (dragging: boolean) => void;
}

function SceneContents({
  orbitEnabled,
  gizmoMode,
  onDraggingChanged,
}: SceneContentsProps): React.ReactElement {
  const document = useStore((s) => s.document);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const selection = useStore((s) => s.document.selection);
  const allEntityIds = useStore((s) => s.document.order);
  const { camera: cam } = document;

  // R3 narrow selector: quality settings derived from entity count + user override.
  const quality = useRenderQuality();
  const palette = useViewportPalette();

  const initialPosition = useMemo(
    () =>
      sphericalToCartesian(
        cam.target as [number, number, number],
        cam.azimuth,
        cam.polar,
        cam.distance,
      ),
    // Only used for initial mount — intentionally not reactive to later cam changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const targetVec = useMemo(
    () => new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]),
    // Same: initial mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The entities + gizmo group is offset by -renderOrigin so that all entity
  // positions (expressed in document world coords) become relative to the
  // render origin — keeping float32 mesh positions small (avoids jitter).
  // Raycasting is automatically correct: three.js resolves click events in
  // world space using the mesh's matrixWorld, which accounts for the group offset.
  const groupOffset = useMemo(
    () => new THREE.Vector3(-renderOrigin[0], -renderOrigin[1], -renderOrigin[2]),
    [renderOrigin],
  );

  return (
    <>
      {/* ---- Theme-aware clear color ---- */}
      <color attach="background" args={[palette.background]} />

      {/* ---- Camera + controls ---- */}
      {/* up={[0,0,1]}: world up is +Z (right-handed, Z-up document convention). */}
      <PerspectiveCamera
        makeDefault
        fov={45}
        near={0.01}
        far={1e8}
        position={initialPosition}
        up={[0, 0, 1]}
      />
      <OrbitControls
        makeDefault
        target={targetVec}
        minDistance={0.1}
        maxDistance={5e6}
        enableDamping
        dampingFactor={0.06}
        screenSpacePanning={false}
        enabled={orbitEnabled}
        up={[0, 0, 1]}
      />

      {/* ---- Camera reactor: syncs document.camera commands to the live camera ---- */}
      <CameraReactor />

      {/* ---- Demand-mode invalidation: re-render on store/document changes ---- */}
      <StoreInvalidator />

      {/* ---- Demand-mode invalidation: re-render on viewport render-state changes ---- */}
      <ViewportStoreInvalidator />

      {/* ---- Per-frame rebase check — no setState per frame ---- */}
      <RenderOriginSyncer />
      <AdaptiveClipping />

      {/* ---- View preset camera driver — reads store via props to avoid Canvas re-render ---- */}
      <ViewPresetsInner
        entities={
          document.entities as Record<string, { position: readonly [number, number, number] }>
        }
        selection={selection}
        allEntityIds={allEntityIds}
      />

      {/* ---- Named-view camera bridge — exposes snapshot/apply callbacks across Canvas boundary ---- */}
      <NamedViewsInner />

      {/* ---- Section / clipping plane sync ---- */}
      <ClippingPlane />

      {/* ---- Animation player — evaluates document.animations per-frame ---- */}
      <AnimationPlayer />

      {/* ---- IBL environment: studio preset for reflections/ambient; no background.
           Kept on across all quality tiers — it is a single texture sample (cheap)
           and significantly improves material quality. ---- */}
      {quality.environmentEnabled && (
        // Procedural studio IBL — no network fetch (preset="studio" pulls an HDR from a CDN
        // and crashes the viewport offline).
        <Environment background={false} resolution={256}>
          <Lightformer form="rect" intensity={2} position={[0, 5, 5]} scale={[10, 6, 1]} />
          <Lightformer form="rect" intensity={1} position={[-6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="rect" intensity={1} position={[6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="ring" intensity={0.6} position={[0, 0, -4]} scale={8} />
        </Environment>
      )}

      {/* ---- Soft shadow patch: PCSS-style softening on the shadow map.
           Disabled in Low tier (softShadowSamples === 0) to save per-fragment cost.
           Medium tier: 8 samples (halved from High's 16). ---- */}
      {quality.softShadowSamples > 0 && (
        <SoftShadows size={25} samples={quality.softShadowSamples} focus={0.5} />
      )}

      {/* ---- Light rig ----
           hemisphere: warm ground / cool sky fill to avoid pure-black undersides.
           directional key: high-angle from front-right, casts shadows.
             shadow-mapSize scales with quality tier (2048 High / 1024 Medium+Low).
           directional rim: cool back-left counter fill.  */}
      <hemisphereLight args={['#c8d8f0', '#3a3228', 0.45]} position={[0, 0, 1]} />
      <directionalLight
        position={[8, -6, 14]}
        intensity={1.8}
        castShadow
        shadow-mapSize={[quality.shadowMapSize, quality.shadowMapSize]}
        shadow-camera-near={0.5}
        shadow-camera-far={200}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-6, 8, 4]} intensity={0.4} color="#a8c8ff" />

      {/* ---- Contact shadows: rendered once (frames=1) — safe under demand frameloop.
           Disabled in Low tier to avoid the extra render pass. ---- */}
      {quality.contactShadowsEnabled && (
        <ContactShadows
          position={[0, 0, -0.001]}
          rotation={GROUND_PLANE_ROTATION}
          opacity={palette.contactShadowOpacity}
          scale={40}
          blur={2.5}
          far={20}
          frames={1}
          color="#1a1e2a"
        />
      )}

      {/* ---- Ground grid ---- */}
      <Grid
        args={[40, 40]}
        cellSize={1}
        cellThickness={0.5}
        cellColor={palette.gridCell}
        sectionSize={5}
        sectionThickness={1}
        sectionColor={palette.gridSection}
        fadeDistance={80}
        fadeStrength={1.5}
        position={[0, 0, 0]}
        rotation={GROUND_PLANE_ROTATION}
        infiniteGrid
      />

      {/* ---- Entities + gizmo, offset by -renderOrigin ----
           Entity positions are document world coords; the group subtracts
           renderOrigin so three.js sees float32-safe local values.
           Raycasts work correctly: three.js resolves hits via matrixWorld which
           includes the group transform. */}
      <group position={groupOffset}>
        <Entities document={document} />
        <TransformGizmo mode={gizmoMode} onDraggingChanged={onDraggingChanged} />
        {/* Measurement bbox wireframe — shown when measure_bounding_box result is present */}
        <MeasureBBoxWireframe />
        {/* Mechanism overlay — constraint line or joint arrow for the highlighted mechanism item */}
        <MechanismOverlay />
      </group>

      {/* ---- Orientation gizmo (bottom-right corner) ---- */}
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport axisColors={palette.axisColors} labelColor={palette.axisLabel} />
      </GizmoHelper>
    </>
  );
}

export function Viewport3D(): React.ReactElement {
  const clearSelection = useStore((s) => s.clearSelection);
  const gizmoMode = useToolStore((s) => s.gizmoMode);

  // Disable OrbitControls while the gizmo is being dragged.
  const [orbitEnabled, setOrbitEnabled] = useState(true);

  const handleDraggingChanged = useCallback((dragging: boolean): void => {
    setOrbitEnabled(!dragging);
  }, []);

  const handlePointerMissed = useCallback((): void => {
    clearSelection();
  }, [clearSelection]);

  return (
    <div className="viewport-3d-wrapper">
      <Canvas
        frameloop="demand"
        shadows
        gl={{
          antialias: true,
          alpha: false,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.1,
        }}
        dpr={[1, 2]}
        style={{ width: '100%', height: '100%' }}
        onPointerMissed={handlePointerMissed}
      >
        <Suspense fallback={null}>
          <SceneContents
            orbitEnabled={orbitEnabled}
            gizmoMode={gizmoMode}
            onDraggingChanged={handleDraggingChanged}
          />
        </Suspense>
      </Canvas>

      {/* View presets, fit and named views (top-right) */}
      <ViewPresetsOverlay />

      {/* Display mode + section plane controls (top-left) */}
      <ViewportControls />
    </div>
  );
}
