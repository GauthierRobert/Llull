/**
 * @layer ui/viewport/2d
 * 2D drafting viewport: the same three.js scene through an orthographic top-down camera
 * (MapControls pan/zoom, disabled while a draw tool is active), an adaptive grid, a ScaleBar HUD
 * and floating-origin rendering. `frameloop="demand"`; presentational only, changes go through
 * dispatch.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { adaptiveGridStep, majorGridStep, localGridPatch } from './gridHelpers';
import { MeasureBBoxRect2D } from './MeasureBBoxRect2D';
import { useViewportPalette } from '@ui/viewport/viewportPalette';
import { StoreInvalidator } from '../StoreInvalidator';
import { RenderOriginSyncer } from '../RenderOriginSyncer';

/**
 * Reacts to camera zoom + viewport size each frame and updates the grid.
 * Uses useFrame + refs (never setState per frame — R9).
 *
 * Renders TWO line-grid meshes:
 *   - minor: thin lines, step = adaptiveGridStep(zoom)
 *   - major: thicker lines, step = 10 × minor step
 *
 * The grid is a LOCAL adapted mesh: a finite patch sized to ~GRID_MARGIN× the
 * visible viewport (localGridPatch), re-centered on the step-snapped camera
 * position every frame so it APPEARS infinite. A fixed huge extent is not an
 * option — at high zoom (step → 0) its cell count would explode to millions of
 * lines and be impossible to render. Sizing to the viewport keeps the line
 * count bounded at any zoom because the cell step is pixel-bounded.
 *
 * The grid position follows the camera XY so it always covers the view at world
 * Z=0 regardless of any floating-origin offset applied to the entities group.
 */
interface AdaptiveGrid2DProps {
  minorColor: number;
  majorColor: number;
}

function AdaptiveGrid2D({
  minorColor,
  majorColor,
}: AdaptiveGrid2DProps): React.ReactElement | null {
  const minorRef = useRef<THREE.GridHelper | null>(null);
  const majorRef = useRef<THREE.GridHelper | null>(null);
  // Track the last-built grid params; rebuild geometry only when they change.
  const lastStepRef = useRef<number>(0);
  const lastMinorDivRef = useRef<number>(0);
  const lastMajorDivRef = useRef<number>(0);

  // Build initial helpers with placeholder geometry — replaced in useFrame.
  const minorHelper = useMemo(() => {
    const h = new THREE.GridHelper(100, 10, minorColor, minorColor);
    h.rotation.x = Math.PI / 2; // lay flat on XY plane
    h.renderOrder = -1;
    return h;
  }, [minorColor]);

  const majorHelper = useMemo(() => {
    const h = new THREE.GridHelper(100, 10, majorColor, majorColor);
    h.rotation.x = Math.PI / 2;
    h.renderOrder = -1;
    return h;
  }, [majorColor]);

  useEffect(() => {
    return () => {
      minorHelper.geometry.dispose();
      (minorHelper.material as THREE.Material).dispose();
      majorHelper.geometry.dispose();
      (majorHelper.material as THREE.Material).dispose();
    };
  }, [minorHelper, majorHelper]);

  const { camera, size } = useThree();

  useFrame(() => {
    const ortho = camera as THREE.OrthographicCamera;
    const zoom = ortho.zoom > 0 ? ortho.zoom : 50;

    const step = adaptiveGridStep(zoom);
    const majorStep = majorGridStep(step);

    // Visible viewport in world units (px / zoom). Size the local patch to it.
    const visibleWorld = Math.max(size.width, size.height) / zoom;
    const minorPatch = localGridPatch(visibleWorld, step);
    const majorPatch = localGridPatch(visibleWorld, majorStep);

    // Rebuild grid geometry only when step or division count changes
    // (avoids per-frame allocs while panning at a fixed zoom).
    if (
      step !== lastStepRef.current ||
      minorPatch.divisions !== lastMinorDivRef.current ||
      majorPatch.divisions !== lastMajorDivRef.current
    ) {
      lastStepRef.current = step;
      lastMinorDivRef.current = minorPatch.divisions;
      lastMajorDivRef.current = majorPatch.divisions;

      // Swap geometry in-place: build a scratch helper for the new patch,
      // dispose the old geometry, assign the new one, then dispose only the
      // scratch material (the persistent helper owns its own material).

      // Rebuild minor
      const scratchMinor = new THREE.GridHelper(
        minorPatch.extent,
        minorPatch.divisions,
        minorColor,
        minorColor,
      );
      scratchMinor.rotation.x = Math.PI / 2;
      if (minorRef.current) {
        minorRef.current.geometry.dispose();
        minorRef.current.geometry = scratchMinor.geometry;
      }
      (scratchMinor.material as THREE.Material).dispose();

      // Rebuild major
      const scratchMajor = new THREE.GridHelper(
        majorPatch.extent,
        majorPatch.divisions,
        majorColor,
        majorColor,
      );
      scratchMajor.rotation.x = Math.PI / 2;
      if (majorRef.current) {
        majorRef.current.geometry.dispose();
        majorRef.current.geometry = scratchMajor.geometry;
      }
      (scratchMajor.material as THREE.Material).dispose();
    }

    // Follow the camera XY pan, snapped to the step so grid lines stay aligned
    // to world-step multiples (matching the snap grid). The patch is centered
    // here, so the even-division patch covers the view in all directions.
    const snapX = Math.round(ortho.position.x / step) * step;
    const snapY = Math.round(ortho.position.y / step) * step;
    if (minorRef.current) {
      minorRef.current.position.set(snapX, snapY, -0.01);
    }
    if (majorRef.current) {
      majorRef.current.position.set(snapX, snapY, -0.02);
    }
  });

  return (
    <>
      <primitive ref={minorRef} object={minorHelper} />
      <primitive ref={majorRef} object={majorHelper} />
    </>
  );
}

/**
 * Reads the ortho camera zoom on each frame and calls `onZoom` when it changes.
 * Uses a ref to gate calls — only fires when zoom actually changes.
 * onZoom should be stable (useCallback).
 */
interface ZoomReaderProps {
  onZoom: (zoom: number) => void;
}

function ZoomReader({ onZoom }: ZoomReaderProps): null {
  const { camera } = useThree();
  const lastZoomRef = useRef<number>(50); // matches OrthographicCamera zoom default
  const onZoomRef = useRef(onZoom);
  useEffect(() => {
    onZoomRef.current = onZoom;
  }, [onZoom]);

  useFrame(() => {
    const zoom = (camera as THREE.OrthographicCamera).zoom ?? 50;
    if (zoom !== lastZoomRef.current) {
      lastZoomRef.current = zoom;
      onZoomRef.current(zoom);
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

  // Offset entity group by -renderOrigin (XY only; Z stays 0 for top-down).
  // Entity world positions are document coords; subtracting renderOrigin keeps
  // three.js float32 vertex values small (same technique as Viewport3D).
  // Raycasts are correct because three.js resolves hits via matrixWorld which
  // includes the group transform. Snap world-coords in useSnap remain in
  // document space — unaffected by this render-only offset (R9, architecture L7).
  const groupOffset = useMemo(
    () => new THREE.Vector3(-renderOrigin[0], -renderOrigin[1], 0),
    [renderOrigin],
  );

  return (
    <>
      {/* ---- Camera: top-down orthographic, looking along -Z ---- */}
      <OrthographicCamera makeDefault position={[0, 0, 100]} near={0.01} far={10000} zoom={50} />

      {/* ---- Controls: pan + zoom only; disabled while drawing or modifying ---- */}
      <MapControls
        makeDefault
        enabled={!isDrawing && !isModifying}
        enableRotate={false}
        screenSpacePanning={true}
        zoomSpeed={1.2}
        panSpeed={1.0}
      />

      {/* ---- Demand-mode invalidation: re-render on store/document changes ---- */}
      <StoreInvalidator />

      {/* ---- Frame the document on mount and on fit_view / camera changes ---- */}
      <ZoomExtents2D />

      {/* ---- Per-frame rebase check — keeps float32 coords small ---- */}
      <RenderOriginSyncer />

      {/* ---- Zoom reader: surfaces zoom to the HTML ScaleBar overlay ---- */}
      <ZoomReader onZoom={onZoom} />

      {/* ---- Ambient light (flat look for 2D drafting) ---- */}
      <ambientLight intensity={1.0} />

      {/* ---- Adaptive 2D grid on the XY plane ---- */}
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

  const handleZoom = useCallback((zoom: number) => {
    setCameraZoom(zoom);
  }, []);

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
            onZoom={handleZoom}
            zoom={cameraZoom}
            activeModifyTool={activeModifyTool}
            modifyPhase={modifyPhase}
            onEntityPick={handleEntityPick}
          />
        </Suspense>
      </Canvas>

      {/* HTML overlay: scale bar (bottom-right) */}
      <ScaleBar zoom={cameraZoom} document={document} />

      {/* Left-edge dock: 2D modify palette (draw tools live in the main toolbar) */}
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
