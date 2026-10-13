// 3D perspective viewport: one <Canvas frameloop="demand"> repainted by store invalidators; quality tier scales
// shadows/environment. Entities + gizmo sit in a group offset by -renderOrigin (float32-safe floating origin).

import { Suspense, useCallback, useMemo, useState } from 'react';
// First among the three.js imports: its three-mesh-bvh typings must win over drei's older copy.
import { ensureBvhSetup } from './bvhSetup';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { type GizmoMode, useStore, useToolStore } from '@ui/store';
import { Entities } from './Entities';
import { TransformGizmo } from './TransformGizmo';
import { RenderOriginSyncer } from '../RenderOriginSyncer';
import { ViewPresetsOverlay } from './ViewPresets';
import { CameraBridge } from './cameraBridge';
import { MeasureBBoxWireframe } from './MeasureBBoxWireframe';
import { ClippingPlane } from './ClippingPlane';
import { ViewportControls } from './ViewportControls';
import { AnimationPlayer } from './AnimationPlayer';
import { useRenderQuality } from './useRenderQuality';
import { AdaptiveClipping, CameraReactor, sphericalToCartesian } from './CameraRig';
import { GROUND_PLANE_ROTATION, SceneLighting } from './SceneLighting';
import { MechanismOverlay } from './MechanismOverlay';
import { useViewportPalette } from '@ui/viewport/viewportPalette';
import { StoreInvalidator, ViewportStoreInvalidator } from '../StoreInvalidator';

// Idempotent, StrictMode-safe.
ensureBvhSetup();

interface SceneContentsProps {
  /** False while a gizmo drag is in progress. */
  orbitEnabled: boolean;
  gizmoMode: GizmoMode;
  onDraggingChanged: (dragging: boolean) => void;
}

function SceneContents({ orbitEnabled, gizmoMode, onDraggingChanged }: SceneContentsProps): React.ReactElement {
  const renderOrigin = useStore((s) => s.renderOrigin);

  const quality = useRenderQuality();
  const palette = useViewportPalette();

  // Initial camera only: CameraReactor applies later changes imperatively.
  const [initialCamera] = useState(() => {
    const cam = useStore.getState().document.camera;
    return {
      position: sphericalToCartesian(cam.target, cam.azimuth, cam.polar, cam.distance),
      target: new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]),
    };
  });

  // Small float32 positions (no jitter); raycasts resolve in world space through matrixWorld, so picking stays correct.
  const groupOffset = useMemo(() => new THREE.Vector3(-renderOrigin[0], -renderOrigin[1], -renderOrigin[2]), [renderOrigin]);

  return (
    <>
      <color attach="background" args={[palette.background]} />

      {/* up={[0,0,1]}: world up is +Z (right-handed, Z-up document convention); OrbitControls
          orbits about the camera's up. */}
      <PerspectiveCamera makeDefault fov={VIEWPORT_FOV_DEGREES} near={0.01} far={1e8} position={initialCamera.position} up={[0, 0, 1]} />
      <OrbitControls
        makeDefault
        target={initialCamera.target}
        minDistance={0.01}
        maxDistance={5e6}
        enableDamping
        dampingFactor={0.06}
        screenSpacePanning={false}
        enabled={orbitEnabled}
      />

      <CameraReactor />

      <StoreInvalidator />

      <ViewportStoreInvalidator />

      <RenderOriginSyncer />
      <AdaptiveClipping />

      <CameraBridge />

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

      <group position={groupOffset}>
        <Entities />
        <TransformGizmo mode={gizmoMode} onDraggingChanged={onDraggingChanged} />
        <MeasureBBoxWireframe />
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
        gl={{ antialias: true, alpha: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1 }}
        dpr={[1, 2]}
        style={{ width: '100%', height: '100%' }}
        onPointerMissed={handlePointerMissed}
      >
        <Suspense fallback={null}>
          <SceneContents orbitEnabled={orbitEnabled} gizmoMode={gizmoMode} onDraggingChanged={handleDraggingChanged} />
        </Suspense>
      </Canvas>

      <ViewPresetsOverlay />

      <ViewportControls />
    </div>
  );
}
