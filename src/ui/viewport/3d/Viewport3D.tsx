/**
 * @layer ui/viewport/3d
 * 3D perspective viewport: one r3f <Canvas frameloop="demand"> repainted by the store
 * invalidators. Quality tier (useRenderQuality) scales shadows/environment to the entity count.
 * Entities + gizmo sit in a group offset by -renderOrigin (float32-safe floating origin).
 * Presentational only: changes go through dispatch.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ensureBvhSetup } from './bvhSetup';

// Engage BVH prototype patch once at module load — idempotent, safe under StrictMode.
ensureBvhSetup();
import { Canvas, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
  PerspectiveCamera,
} from '@react-three/drei';
import * as THREE from 'three';
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
import { AdaptiveClipping, CameraReactor, sphericalToCartesian } from './CameraRig';
import { GROUND_PLANE_ROTATION, SceneLighting } from './SceneLighting';
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

  // Initial camera only: later camera changes are applied imperatively by CameraReactor.
  const [initialCamera] = useState(() => ({
    position: sphericalToCartesian(
      cam.target as [number, number, number],
      cam.azimuth,
      cam.polar,
      cam.distance,
    ),
    target: new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]),
  }));

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
      <color attach="background" args={[palette.background]} />

      {/* up={[0,0,1]}: world up is +Z (right-handed, Z-up document convention). */}
      <PerspectiveCamera
        makeDefault
        fov={45}
        near={0.01}
        far={1e8}
        position={initialCamera.position}
        up={[0, 0, 1]}
      />
      <OrbitControls
        makeDefault
        target={initialCamera.target}
        minDistance={0.1}
        maxDistance={5e6}
        enableDamping
        dampingFactor={0.06}
        screenSpacePanning={false}
        enabled={orbitEnabled}
        up={[0, 0, 1]}
      />

      <CameraReactor />

      <StoreInvalidator />

      <ViewportStoreInvalidator />

      <RenderOriginSyncer />
      <AdaptiveClipping />

      <ViewPresetsInner
        entities={
          document.entities as Record<string, { position: readonly [number, number, number] }>
        }
        selection={selection}
        allEntityIds={allEntityIds}
      />

      <NamedViewsInner />

      <ClippingPlane />

      <AnimationPlayer />

      <SceneLighting quality={quality} contactShadowOpacity={palette.contactShadowOpacity} />

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
