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
import { DimensionLens } from './DimensionLens';
import { PmiLayer } from './PmiLayer';
import { ViewOptionsToggle } from './ViewOptionsToggle';
import { useChromeStore } from '@ui/store/chromeStore';
import { RenderOriginSyncer } from '../RenderOriginSyncer';
import { ViewPresetsOverlay } from './ViewPresets';
import { CameraBridge } from './cameraBridge';
import { MeasureBBoxWireframe } from './MeasureBBoxWireframe';
import { ClippingPlane } from './ClippingPlane';
import { ViewportControls } from './ViewportControls';
import { AnimationPlayer } from './AnimationPlayer';
import { DynamicsPlayer } from './DynamicsPlayer';
import { useRenderQuality } from './useRenderQuality';
import { AdaptiveClipping, CameraReactor, OrbitSettle, sphericalToCartesian } from './CameraRig';
import { GROUND_PLANE_ROTATION, SceneLighting } from './SceneLighting';
import { MechanismOverlay } from './MechanismOverlay';
import { DynamicsLoadsOverlay } from './DynamicsLoadsOverlay';
import { AeroOverlay } from './aero/AeroOverlay';
import { StructuralOverlay } from './structural/StructuralOverlay';
import { FindingsOverlay } from './findings/FindingsOverlay';
import { useViewportPalette } from '@ui/viewport/viewportPalette';
import { StoreInvalidator, ViewportStoreInvalidator } from '../StoreInvalidator';
import { LiveFxCamera } from '../liveFx/LiveFxCamera';
import { ScreenAnchorOverlay } from '../screenAnchor/ScreenAnchorOverlay';
import { FocusOverlay } from '../FocusOverlay';
import { FocusBanner } from '../FocusBanner';
import { AnalysisOverlay } from './analysis/AnalysisOverlay';
import { AnalysisLegend } from './analysis/AnalysisLegend';
import { SweepFramesOverlay } from './analysis/SweepFramesOverlay';
import { type PanelFocus, useFocusStore } from '@ui/store/focusStore';
import { zoomToFocus } from './zoomToFocus';
import { FeatureSessionLayer } from './manipulators/FeatureSessionLayer';
import { FeatureStartBar } from './manipulators/FeatureStartBar';
import { CageEditLayer } from './cage/CageEditLayer';
import { FaceEditLayer } from './faceEdit/FaceEditLayer';
import { FaceEditBar } from './faceEdit/FaceEditBar';
import { NurbsNetLayer } from './nurbsNet/NurbsNetLayer';
import { NurbsNetBar } from './nurbsNet/NurbsNetBar';
import { RemotePreviewLayer } from './preview/RemotePreviewLayer';
import { CageEditBar } from './cage/CageEditBar';
import { SpaceMouseControl } from '@ui/input/SpaceMouseControl';

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
      <OrbitSettle />

      <CameraBridge />

      <LiveFxCamera />

      <ClippingPlane />

      <AnimationPlayer />
      <DynamicsPlayer />

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
        <FeatureSessionLayer />
        <CageEditLayer onDraggingChanged={onDraggingChanged} />
        <FaceEditLayer />
        <NurbsNetLayer />
        <RemotePreviewLayer />
        <MeasureBBoxWireframe />
        <MechanismOverlay />
        <DynamicsLoadsOverlay />
        <AeroOverlay />
        <StructuralOverlay />
        <FindingsOverlay />
        <DimensionLens />
        <PmiLayer />
        <AnalysisOverlay />
        <SweepFramesOverlay />
        <FocusOverlay />
      </group>

      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport axisColors={palette.axisColors} labelColor={palette.axisLabel} />
      </GizmoHelper>
    </>
  );
}

const zoomToHighlight = (focus: PanelFocus): void => zoomToFocus(useStore.getState().document, focus);

export function Viewport3D(): React.ReactElement {
  const clearSelection = useStore((s) => s.clearSelection);
  const gizmoMode = useToolStore((s) => s.gizmoMode);
  const viewOptionsOpen = useChromeStore((s) => s.viewOptionsOpen);

  const [orbitEnabled, setOrbitEnabled] = useState(true);

  const handleDraggingChanged = useCallback((dragging: boolean): void => {
    setOrbitEnabled(!dragging);
  }, []);

  const handlePointerMissed = useCallback((): void => {
    clearSelection();
    useFocusStore.getState().setFocus(null);
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

      <ScreenAnchorOverlay />
      <div className="feature-start-stack">
        <FeatureStartBar />
        <CageEditBar />
        <FaceEditBar />
        <NurbsNetBar />
      </div>
      <SpaceMouseControl />
      <FocusBanner onZoom={zoomToHighlight} />
      <AnalysisLegend />
      <ViewOptionsToggle />
      {viewOptionsOpen && (
        <>
          <ViewPresetsOverlay />
          <ViewportControls />
        </>
      )}
    </div>
  );
}
