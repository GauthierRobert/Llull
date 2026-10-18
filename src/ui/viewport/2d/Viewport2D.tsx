// 2D drafting viewport: the same scene through an ortho top-down camera (MapControls; pan off while a tool is armed),
// adaptive grid, ScaleBar HUD, floating origin, frameloop="demand".

import { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera, MapControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import { type DrawToolKind, type ModifyToolKind, useStore } from '@ui/store';
import { cameraGestures, MAP_CONTROLS_CONFIG } from './cameraControlsPolicy';
import { computePlanDepth, PLAN_CAMERA_HEIGHT } from './planDepth';
import { ZoomExtents2D } from './ZoomExtents2D';
import { Entities2D } from './Entities2D';
import { BuildingPlan2D } from './BuildingPlan2D';
import { SnapIndicator } from './SnapIndicator';
import { DrawInteraction } from './DrawInteraction';
import { useDrawTool } from './useDrawTool';
import { ModifyTools } from './ModifyTools';
import { type ModifyToolPhase, useModifyTool } from './useModifyTool';
import { ModifyPickInteraction } from './ModifyPickInteraction';
import { SelectPickInteraction } from './SelectPickInteraction';
import { BoxSelectInteraction } from './BoxSelectInteraction';
import { ScaleBar } from './ScaleBar';
import { AdaptiveGrid2D } from './AdaptiveGrid2D';
import { MeasureBBoxRect2D } from './MeasureBBoxRect2D';
import { useViewportPalette } from '@ui/viewport/viewportPalette';
import { StoreInvalidator } from '../StoreInvalidator';
import { RenderOriginSyncer } from '../RenderOriginSyncer';
import { ScreenAnchorOverlay } from '../screenAnchor/ScreenAnchorOverlay';

/** Reports the ortho camera zoom to the HTML overlay, only when it changes. */
function ZoomReader({ onZoom }: { onZoom: (zoom: number) => void }): null {
  const { camera } = useThree();
  const lastZoomRef = useRef<number>(50); // matches the OrthographicCamera zoom prop
  useFrame(() => {
    const zoom = (camera as THREE.OrthographicCamera).zoom;
    if (zoom !== lastZoomRef.current) {
      lastZoomRef.current = zoom;
      onZoom(zoom);
    }
  });
  return null;
}

interface SceneContents2DProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  onClickPoint: (point: Vec2) => void;
  onDoubleClick: () => void;
  onZoom: (zoom: number) => void;
  zoom: number;
  activeModifyTool: ModifyToolKind;
  modifyPhase: ModifyToolPhase;
  onEntityPick: (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => void;
}

function SceneContents2D({
  activeTool,
  collectedPoints,
  onClickPoint,
  onDoubleClick,
  onZoom,
  zoom,
  activeModifyTool,
  modifyPhase,
  onEntityPick,
}: SceneContents2DProps): React.ReactElement {
  const renderOrigin = useStore((s) => s.renderOrigin);
  const isDrawing = activeTool !== 'none';
  const isModifying = activeModifyTool !== 'none';
  const palette = useViewportPalette();

  // Render-only floating origin: shifts the entity group, so pointer hits and snaps stay in document space.
  const order = useStore((s) => s.document.order);
  const entities = useStore((s) => s.document.entities);
  // Lifted work planes (contours, DXF elevations) are brought into the camera's depth range.
  const planDepth = useMemo(() => computePlanDepth(order, entities), [order, entities]);
  const groupOffset = useMemo(() => new THREE.Vector3(-renderOrigin[0], -renderOrigin[1], -planDepth.top), [renderOrigin, planDepth.top]);

  return (
    <>
      <OrthographicCamera makeDefault position={[0, 0, PLAN_CAMERA_HEIGHT]} near={0.01} far={planDepth.far} zoom={50} />

      <MapControls makeDefault {...MAP_CONTROLS_CONFIG} {...cameraGestures(isDrawing || isModifying)} />

      <StoreInvalidator />

      <ZoomExtents2D />

      <RenderOriginSyncer />

      <ZoomReader onZoom={onZoom} />

      <ambientLight intensity={1.0} />

      <color attach="background" args={[palette.background]} />
      <AdaptiveGrid2D
        key={`${palette.grid2dMinor}-${palette.grid2dMajor}`}
        minorColor={palette.grid2dMinor}
        majorColor={palette.grid2dMajor}
        baseZ={planDepth.floor}
      />

      {/* One offset group: pointer e.point resolves in document space, the snap candidate frame. */}
      <group position={groupOffset}>
        <BuildingPlan2D />
        <Entities2D />

        {!isDrawing && !isModifying && <SnapIndicator zoom={zoom} />}
        {!isDrawing && !isModifying && <SelectPickInteraction zoom={zoom} />}
        {!isDrawing && !isModifying && <BoxSelectInteraction zoom={zoom} />}

        <DrawInteraction
          activeTool={activeTool}
          collectedPoints={collectedPoints}
          onClickPoint={onClickPoint}
          onDoubleClick={onDoubleClick}
          zoom={zoom}
        />

        <ModifyPickInteraction activeTool={activeModifyTool} phase={modifyPhase} zoom={zoom} onEntityPick={onEntityPick} />

        <MeasureBBoxRect2D />
      </group>
    </>
  );
}

export function Viewport2D(): React.ReactElement {
  const { activeTool, collectedPoints, handleClick, finishChain } = useDrawTool();

  const {
    activeTool: activeModifyTool,
    phase: modifyPhase,
    pendingValue,
    toggleTool: toggleModifyTool,
    handleEntityPick,
    setPendingValue,
    commitValue,
  } = useModifyTool();
  const hasSelection = useStore((s) => s.document.selection.length > 0);

  // Set by ZoomReader inside the canvas, read by ScaleBar outside; starts at the camera's zoom prop.
  const [cameraZoom, setCameraZoom] = useState<number>(50);

  return (
    <div className="viewport-2d-wrapper">
      <Canvas frameloop="demand" gl={{ antialias: true, alpha: false }} dpr={[1, 2]} orthographic style={{ width: '100%', height: '100%' }}>
        <Suspense fallback={null}>
          <SceneContents2D
            activeTool={activeTool}
            collectedPoints={collectedPoints}
            onClickPoint={handleClick}
            onDoubleClick={finishChain}
            onZoom={setCameraZoom}
            zoom={cameraZoom}
            activeModifyTool={activeModifyTool}
            modifyPhase={modifyPhase}
            onEntityPick={handleEntityPick}
          />
        </Suspense>
      </Canvas>

      <ScreenAnchorOverlay />
      <ScaleBar zoom={cameraZoom} />

      {/* On demand: the modify palette shows once there is something to modify. */}
      <div className="vp-tool-dock" hidden={!hasSelection && activeModifyTool === 'none'}>
        <ModifyTools
          activeTool={activeModifyTool}
          phase={modifyPhase}
          pendingValue={pendingValue}
          onToggleTool={toggleModifyTool}
          onSetValue={setPendingValue}
          onCommitValue={commitValue}
        />
      </div>
    </div>
  );
}
