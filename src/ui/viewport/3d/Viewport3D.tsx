/**
 * @layer ui/viewport/3d
 *
 * The 3D perspective viewport.
 *
 * - A single r3f <Canvas frameloop="demand"> — renders only when invalidated,
 *   so idle scenes consume no GPU/CPU. Invalidation sources:
 *     • OrbitControls / TransformControls: drei calls invalidate() on 'change'.
 *     • Document / selection / renderOrigin: StoreInvalidator subscribes to the
 *       Zustand store and calls invalidate() whenever those slices change.
 *     • Viewport render state (displayMode / clipPlane / hiddenEntityIds):
 *       ViewportStoreInvalidator subscribes to the viewport store and calls
 *       invalidate() on any render-state change.
 * - OrbitControls (drei) for pan/orbit/zoom — disabled while a TransformGizmo
 *   drag is in progress so the camera does not fight the gizmo.
 * - Ground grid + axes for spatial reference.
 * - Ambient + directional lighting.
 * - An <Entities> group that renders every entity in the document.
 * - <TransformGizmo> appears when exactly one entity is selected and lets the
 *   user translate/rotate/scale by dispatching the matching command on drag end.
 *   <GizmoModeToggle> is an overlay outside the Canvas sharing the same mode.
 * - Floating-origin rendering: entities + gizmo are wrapped in a group offset by
 *   -renderOrigin so that float32 vertex positions stay small regardless of true
 *   world coordinates (avoids jitter for geometry far from world origin).
 *   RenderOriginSyncer runs inside useFrame; because OrbitControls already calls
 *   invalidate() on every camera change event, useFrame fires on each orbit frame
 *   and the rebase check continues to work correctly under demand mode.
 * - <ClippingPlane> (inside Canvas): syncs the viewport-store clip state to the
 *   three.js renderer's clippingPlanes + localClippingEnabled.
 * - <ViewportControls> (outside Canvas): display-mode segmented button + section
 *   plane UI; state is render-only in the viewport store.
 *
 * This component is purely presentational: it reads from the store and never
 * mutates the document (PRIME DIRECTIVE). All changes go through dispatch.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
  PerspectiveCamera,
  Environment,
  ContactShadows,
  SoftShadows,
} from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import { Entities } from './Entities';
import { TransformGizmo, GizmoModeToggle } from './TransformGizmo';
import { shouldRebase, snapOriginToTarget } from './floatingOrigin';
import type { GizmoMode } from './TransformGizmo';
import { ViewPresetsInner, ViewPresetsOverlay } from './ViewPresets';
import { NamedViewsInner, NamedViewsOverlay } from './NamedViews';
import { MeasureBBoxWireframe } from './MeasureBBoxWireframe';
import { ClippingPlane } from './ClippingPlane';
import { ViewportControls } from './ViewportControls';
import { AnimationPlayer } from './AnimationPlayer';

// ---------------------------------------------------------------------------
// StoreInvalidator — calls r3f invalidate() when the CAD store changes
// ---------------------------------------------------------------------------

/**
 * Subscribes to the Zustand store OUTSIDE the r3f render loop and calls
 * invalidate() whenever document or renderOrigin change. This ensures that
 * entity additions/deletions, selection changes, and render-origin rebases
 * all produce a fresh render frame under frameloop="demand".
 *
 * Must be mounted inside the Canvas so useThree(s => s.invalidate) resolves.
 * Uses useEffect + useStore.subscribe (not a reactive selector) to avoid
 * triggering a React re-render — the only effect is queuing an r3f frame.
 */
function StoreInvalidator(): null {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    // Subscribe to the raw Zustand store (Zustand v5 basic subscribe API).
    // Compare the two slices that require a new render frame by reference;
    // Object.is() is sufficient because commands are pure (L3) and always
    // return new document objects when they change anything.
    let prevDocument = useStore.getState().document;
    let prevOrigin = useStore.getState().renderOrigin;

    return useStore.subscribe((state) => {
      if (state.document !== prevDocument || state.renderOrigin !== prevOrigin) {
        prevDocument = state.document;
        prevOrigin = state.renderOrigin;
        invalidate();
      }
    });
  }, [invalidate]);

  return null;
}

// ---------------------------------------------------------------------------
// ViewportStoreInvalidator — calls r3f invalidate() when viewport render state changes
// ---------------------------------------------------------------------------

/**
 * Subscribes to the viewport store (displayMode, clipPlane, hiddenEntityIds)
 * and calls r3f invalidate() on any change so the Canvas repaints under
 * frameloop="demand". Pattern mirrors StoreInvalidator above.
 */
function ViewportStoreInvalidator(): null {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    let prevMode    = useViewportStore.getState().displayMode;
    let prevClip    = useViewportStore.getState().clipPlane;
    let prevHidden  = useViewportStore.getState().hiddenEntityIds;

    return useViewportStore.subscribe((state) => {
      if (
        state.displayMode     !== prevMode   ||
        state.clipPlane       !== prevClip   ||
        state.hiddenEntityIds !== prevHidden
      ) {
        prevMode   = state.displayMode;
        prevClip   = state.clipPlane;
        prevHidden = state.hiddenEntityIds;
        invalidate();
      }
    });
  }, [invalidate]);

  return null;
}

// ---------------------------------------------------------------------------
// Camera initializer
// ---------------------------------------------------------------------------

/** Convert spherical CameraState → a cartesian THREE.Vector3 eye position. */
function sphericalToCartesian(
  target: [number, number, number],
  azimuth: number,
  polar: number,
  distance: number,
): [number, number, number] {
  const sinPolar = Math.sin(polar);
  return [
    target[0] + distance * sinPolar * Math.sin(azimuth),
    target[1] + distance * Math.cos(polar),
    target[2] + distance * sinPolar * Math.cos(azimuth),
  ];
}

// ---------------------------------------------------------------------------
// RenderOriginSyncer — per-frame rebase check (inside Canvas, no setState/frame)
// ---------------------------------------------------------------------------

/**
 * Checks the OrbitControls target each frame. When the camera target drifts
 * beyond the rebase threshold from the current renderOrigin, calls
 * setRenderOrigin once. Uses a ref to gate calls — only fires when the
 * threshold is newly crossed, not every frame (react.md R6/R9).
 */
function RenderOriginSyncer(): null {
  const { controls } = useThree();
  const renderOrigin = useStore((s) => s.renderOrigin);
  const setRenderOrigin = useStore((s) => s.setRenderOrigin);

  // Mirror renderOrigin into a ref so useFrame can read the latest value without
  // being in useFrame's dependency closure (per-frame closure capture avoidance).
  const originRef = useRef<[number, number, number]>(renderOrigin);
  useEffect(() => {
    originRef.current = renderOrigin;
  }, [renderOrigin]);

  useFrame(() => {
    if (!controls) return;
    // drei's <OrbitControls makeDefault> registers an OrbitControls instance here;
    // it extends EventDispatcher (the store's `controls` type) and exposes `target`.
    // COUPLING: ViewPresets.applyPreset() must call invalidate() + controls.update()
    // before returning so that this useFrame fires on the next demand frame and the
    // rebase check runs against the new target position (P1 carry-forward).
    const orbitTarget = (controls as OrbitControlsImpl).target;
    if (!orbitTarget) return;

    const camTarget: [number, number, number] = [orbitTarget.x, orbitTarget.y, orbitTarget.z];
    if (shouldRebase(camTarget, originRef.current)) {
      const newOrigin = snapOriginToTarget(camTarget);
      originRef.current = newOrigin; // update ref immediately to prevent repeat calls
      setRenderOrigin(newOrigin);
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------

interface SceneContentsProps {
  /** When false, OrbitControls is disabled (gizmo drag in progress). */
  orbitEnabled: boolean;
  gizmoMode: GizmoMode;
  onDraggingChanged: (dragging: boolean) => void;
}

function SceneContents({ orbitEnabled, gizmoMode, onDraggingChanged }: SceneContentsProps): React.ReactElement {
  const document = useStore((s) => s.document);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const selection = useStore((s) => s.document.selection);
  const allEntityIds = useStore((s) => s.document.order);
  const { camera: cam } = document;

  const initialPosition = useMemo(
    () => sphericalToCartesian(cam.target as [number, number, number], cam.azimuth, cam.polar, cam.distance),
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
    () =>
      new THREE.Vector3(-renderOrigin[0], -renderOrigin[1], -renderOrigin[2]),
    [renderOrigin],
  );

  return (
    <>
      {/* ---- Camera + controls ---- */}
      <PerspectiveCamera makeDefault fov={45} near={0.01} far={1e8} position={initialPosition} />
      <OrbitControls
        makeDefault
        target={targetVec}
        minDistance={0.1}
        maxDistance={5e6}
        enableDamping
        dampingFactor={0.06}
        screenSpacePanning={false}
        enabled={orbitEnabled}
      />

      {/* ---- Demand-mode invalidation: re-render on store/document changes ---- */}
      <StoreInvalidator />

      {/* ---- Demand-mode invalidation: re-render on viewport render-state changes ---- */}
      <ViewportStoreInvalidator />

      {/* ---- Per-frame rebase check — no setState per frame ---- */}
      <RenderOriginSyncer />

      {/* ---- View preset camera driver — reads store via props to avoid Canvas re-render ---- */}
      <ViewPresetsInner
        entities={document.entities as Record<string, { position: readonly [number, number, number] }>}
        selection={selection}
        allEntityIds={allEntityIds}
      />

      {/* ---- Named-view camera bridge — exposes snapshot/apply callbacks across Canvas boundary ---- */}
      <NamedViewsInner />

      {/* ---- Section / clipping plane sync ---- */}
      <ClippingPlane />

      {/* ---- Animation player — evaluates document.animations per-frame ---- */}
      <AnimationPlayer />

      {/* ---- IBL environment: studio preset for reflections/ambient; no background ---- */}
      <Environment preset="studio" background={false} />

      {/* ---- Soft shadow patch: PCSS-style softening on the shadow map ---- */}
      <SoftShadows size={25} samples={16} focus={0.5} />

      {/* ---- Light rig ----
           hemisphere: warm ground / cool sky fill to avoid pure-black undersides.
           directional key: high-angle from front-right, casts shadows.
           directional rim: cool back-left counter fill.  */}
      <hemisphereLight args={['#c8d8f0', '#3a3228', 0.45]} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={1.8}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.5}
        shadow-camera-far={200}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-6, 4, -8]} intensity={0.4} color="#a8c8ff" />

      {/* ---- Contact shadows: rendered once (frames=1) — safe under demand frameloop ---- */}
      <ContactShadows
        position={[0, -0.001, 0]}
        opacity={0.55}
        scale={40}
        blur={2.5}
        far={20}
        frames={1}
        color="#1a1e2a"
      />

      {/* ---- Ground grid ---- */}
      <Grid
        args={[40, 40]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#2a3040"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#374055"
        fadeDistance={80}
        fadeStrength={1.5}
        position={[0, 0, 0]}
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
      </group>

      {/* ---- Orientation gizmo (bottom-right corner) ---- */}
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport
          axisColors={['#e05252', '#52c05a', '#4e8de0']}
          labelColor="#e8eaed"
        />
      </GizmoHelper>
    </>
  );
}

// ---------------------------------------------------------------------------
// Viewport3D — the exported component
// ---------------------------------------------------------------------------

export function Viewport3D(): React.ReactElement {
  const clearSelection = useStore((s) => s.clearSelection);
  const selection = useStore((s) => s.document.selection);

  // Gizmo mode — owned here so the overlay toggle and the in-Canvas gizmo
  // share the same value without lifting state through the Canvas boundary.
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');

  // Disable OrbitControls while the gizmo is being dragged.
  const [orbitEnabled, setOrbitEnabled] = useState(true);

  const handleDraggingChanged = useCallback((dragging: boolean): void => {
    setOrbitEnabled(!dragging);
  }, []);

  const handlePointerMissed = useCallback((): void => {
    clearSelection();
  }, [clearSelection]);

  // Keyboard shortcuts: g=translate, r=rotate, s=scale
  // Managed here (outside Canvas) so they work regardless of canvas focus.
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'g') setGizmoMode('translate');
      else if (e.key === 'r') setGizmoMode('rotate');
      else if (e.key === 's') setGizmoMode('scale');
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const showModeToggle = selection.length === 1;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
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
        style={{ width: '100%', height: '100%', background: '#141720' }}
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

      {/* Mode toggle overlay — only visible when a single entity is selected */}
      {showModeToggle && (
        <GizmoModeToggle mode={gizmoMode} onMode={setGizmoMode} />
      )}

      {/* View preset buttons (top-right) */}
      <ViewPresetsOverlay />

      {/* Named-view bookmarks (below view presets) */}
      <NamedViewsOverlay />

      {/* Display mode + section plane controls (top-left) */}
      <ViewportControls />
    </div>
  );
}
