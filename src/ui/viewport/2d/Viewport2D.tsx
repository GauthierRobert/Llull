/**
 * @layer ui/viewport/2d
 * 2D drafting viewport: the same three.js scene through an orthographic top-down camera
 * (MapControls pan/zoom, disabled while a draw tool is active), an adaptive grid, a ScaleBar HUD
 * and floating-origin rendering. `frameloop="demand"`; presentational only, changes go through
 * dispatch.
 */

import { Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera, MapControls } from '@react-three/drei';
import { ZoomExtents2D } from './ZoomExtents2D';
import * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import { Entities2D } from './Entities2D';
import { BuildingPlan2D } from './BuildingPlan2D';
import { SnapIndicator } from './SnapIndicator';
import { DrawInteraction } from './DrawInteraction';
import { useDrawTool } from './useDrawTool';
import type { DrawToolKind } from '@ui/store';
import { ModifyTools } from './ModifyTools';
import { useModifyTool } from './useModifyTool';
import type { ModifyToolKind } from '@ui/store';
import type { ModifyToolPhase } from './useModifyTool';
import { ModifyPickInteraction } from './ModifyPickInteraction';
import { SelectPickInteraction } from './SelectPickInteraction';
import { ScaleBar } from './ScaleBar';
import { AdaptiveGrid2D } from './AdaptiveGrid2D';
import { MeasureBBoxRect2D } from './MeasureBBoxRect2D';
import { useViewportPalette } from '@ui/viewport/viewportPalette';
import { StoreInvalidator } from '../StoreInvalidator';
import { RenderOriginSyncer } from '../RenderOriginSyncer';

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
  /** Current ortho camera zoom — drives the adaptive snap grid + screen-constant glyph. */
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
  const document = useStore((s) => s.document);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const isDrawing = activeTool !== 'none';
  const isModifying = activeModifyTool !== 'none';
  const palette = useViewportPalette();

  // Render-only floating origin: shifts the entity group, so pointer hits and snaps stay in document space.
  const groupOffset = useMemo(
    () => new THREE.Vector3(-renderOrigin[0], -renderOrigin[1], 0),
    [renderOrigin],
  );

  return (
    <>
      <OrthographicCamera makeDefault position={[0, 0, 100]} near={0.01} far={10000} zoom={50} />

      <MapControls
        makeDefault
        enabled={!isDrawing && !isModifying}
        enableRotate={false}
        screenSpacePanning={true}
        zoomSpeed={1.2}
        panSpeed={1.0}
      />

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
      />

      {/* ---- Entities, snap indicator, and draw interaction are all inside
           the same offset group so pointer e.point resolves in document
           space — matching the snap candidate frame (architecture L7).  ---- */}
      <group position={groupOffset}>
        <BuildingPlan2D />
        <Entities2D document={document} />

        {/* Snap indicator + click-to-select: shown when no draw or modify tool is active */}
        {!isDrawing && !isModifying && <SnapIndicator zoom={zoom} />}
        {!isDrawing && !isModifying && <SelectPickInteraction zoom={zoom} />}

        {/* Draw interaction: click-capture + rubber-band preview */}
        <DrawInteraction
          activeTool={activeTool}
          collectedPoints={collectedPoints}
          onClickPoint={onClickPoint}
          onDoubleClick={onDoubleClick}
          zoom={zoom}
        />

        {/* Modify pick interaction: entity-click capture for modify tools */}
        <ModifyPickInteraction
          activeTool={activeModifyTool}
          phase={modifyPhase}
          onEntityPick={onEntityPick}
        />

        {/* Measurement bbox rectangle — shown when measure_bounding_box result is present */}
        <MeasureBBoxRect2D />
      </group>
    </>
  );
}

export function Viewport2D(): React.ReactElement {
  const { activeTool, collectedPoints, handleClick, finishPolyline, finishSpline } = useDrawTool();

  const {
    activeTool: activeModifyTool,
    phase: modifyPhase,
    pendingValue,
    setActiveTool: setModifyTool,
    handleEntityPick,
    setPendingValue,
    commitValue,
  } = useModifyTool();

  const document = useStore((s) => s.document);

  // Camera zoom state — updated by ZoomReader inside the canvas, displayed by
  // ScaleBar outside it. Initial value matches the OrthographicCamera zoom prop.
  const [cameraZoom, setCameraZoom] = useState<number>(50);

  const onDoubleClick = useCallback(() => {
    if (activeTool === 'spline') finishSpline(false);
    else finishPolyline(false);
  }, [activeTool, finishPolyline, finishSpline]);

  return (
    <div className="viewport-2d-wrapper">
      <Canvas
        frameloop="demand"
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
        orthographic
        style={{ width: '100%', height: '100%' }}
      >
        <Suspense fallback={null}>
          <SceneContents2D
            activeTool={activeTool}
            collectedPoints={collectedPoints}
            onClickPoint={handleClick}
            onDoubleClick={onDoubleClick}
            onZoom={setCameraZoom}
            zoom={cameraZoom}
            activeModifyTool={activeModifyTool}
            modifyPhase={modifyPhase}
            onEntityPick={handleEntityPick}
          />
        </Suspense>
      </Canvas>

      <ScaleBar zoom={cameraZoom} document={document} />

      <div className="vp-tool-dock">
        <ModifyTools
          activeTool={activeModifyTool}
          phase={modifyPhase}
          pendingValue={pendingValue}
          onSelectTool={setModifyTool}
          onSetValue={setPendingValue}
          onCommitValue={commitValue}
        />
      </div>
    </div>
  );
}
