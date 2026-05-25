/**
 * @layer ui/viewport/2d
 *
 * The 2D orthographic drafting viewport.
 *
 * - A single r3f <Canvas frameloop="demand"> with an OrthographicCamera
 *   looking straight down the -Z axis onto the XY plane (top-down drafting view).
 * - MapControls (drei) for 2D-appropriate pan + zoom (rotation disabled).
 *   Controls are disabled while a draw tool is active so clicks are not
 *   misinterpreted as panning.
 * - Adaptive grid: minor cell step scales with zoom so lines stay readable
 *   from very-zoomed-in to very-zoomed-out. Computed by adaptiveGridStep().
 * - ScaleBar HUD: an HTML overlay showing the real-world length of a fixed
 *   pixel segment, labeled with document.units / displayPrecision.
 * - Floating-origin rendering for the 2D view: RenderOriginSyncer2D runs
 *   inside useFrame and calls setRenderOrigin when the ortho camera target
 *   drifts beyond the rebase threshold. The entities group is offset by
 *   -renderOrigin (XY only, Z=0 for a top-down view). Snap raycasts are
 *   correct because three.js resolves hits via matrixWorld which includes the
 *   group transform.
 * - StoreInvalidator2D: under frameloop="demand", calls r3f invalidate()
 *   whenever document or renderOrigin change (zoom is covered by MapControls).
 *
 * Purely presentational: reads from the store, never mutates the document
 * (PRIME DIRECTIVE). All changes go through dispatch.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera, MapControls } from '@react-three/drei';
import * as THREE from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import { Entities2D } from './Entities2D';
import { SnapIndicator } from './SnapIndicator';
import { DrawInteraction } from './DrawInteraction';
import { DrawTools } from './DrawTools';
import { useDrawTool } from './useDrawTool';
import type { DrawToolKind } from './useDrawTool';
import { ScaleBar } from './ScaleBar';
import { adaptiveGridStep, majorGridStep, shouldRebase2D, snapOrigin2D } from './gridHelpers';

// ---------------------------------------------------------------------------
// StoreInvalidator2D — calls r3f invalidate() when the store changes
// ---------------------------------------------------------------------------

/**
 * Subscribes to the Zustand store OUTSIDE the r3f render loop and calls
 * invalidate() whenever document or renderOrigin change (zoom is handled by
 * MapControls' own invalidate() call). Pattern mirrors
 * StoreInvalidator in Viewport3D.tsx (architecture L7: one model, two views).
 *
 * Must be mounted inside Canvas so useThree resolves.
 * Uses useEffect + subscribe (not a reactive selector) to avoid a React re-render.
 */
function StoreInvalidator2D(): null {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
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
// RenderOriginSyncer2D — per-frame rebase for the ortho camera
// ---------------------------------------------------------------------------

/**
 * Checks the MapControls target each frame. When the XY pan target drifts
 * beyond the rebase threshold from the current renderOrigin, calls
 * setRenderOrigin once, leaving Z = 0 (the 2D top-down plane).
 *
 * Mirrors RenderOriginSyncer in Viewport3D.tsx but operates on the ortho
 * camera's pan target (MapControls.target.x / .y) instead of OrbitControls.
 *
 * The useFrame callback runs because MapControls already calls invalidate()
 * on every camera-change event — so demand-mode frames fire on each pan/zoom
 * and the rebase check runs on those frames.
 */
function RenderOriginSyncer2D(): null {
  const { controls } = useThree();
  const renderOrigin = useStore((s) => s.renderOrigin);
  const setRenderOrigin = useStore((s) => s.setRenderOrigin);

  const originRef = useRef<[number, number, number]>(renderOrigin);
  useEffect(() => {
    originRef.current = renderOrigin;
  }, [renderOrigin]);

  useFrame(() => {
    if (!controls) return;
    const mapTarget = (controls as MapControlsImpl).target;
    if (!mapTarget) return;

    const ox = originRef.current[0];
    const oy = originRef.current[1];

    if (shouldRebase2D(mapTarget.x, mapTarget.y, ox, oy)) {
      const newOrigin = snapOrigin2D(mapTarget.x, mapTarget.y);
      originRef.current = newOrigin;
      setRenderOrigin(newOrigin);
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// AdaptiveGrid2D — grid whose step scales with orthographic camera zoom
// ---------------------------------------------------------------------------

/**
 * Reacts to camera zoom changes each frame and updates the grid geometry.
 * Uses useFrame + refs (never setState per frame — R9).
 *
 * Renders TWO line-grid meshes:
 *   - minor: thin lines, step = adaptiveGridStep(zoom)
 *   - major: thicker lines, step = 10 × minor step
 *
 * Both grids are infinite planes rendered as line segments via a custom
 * approach: we re-use THREE.GridHelper but repositioned each frame to stay
 * centered on the camera target so it appears infinite.
 *
 * The grid position follows the render origin so it always sits at world Z=0
 * regardless of any floating-origin offset applied to the entities group.
 */
function AdaptiveGrid2D(): React.ReactElement | null {
  const minorRef = useRef<THREE.GridHelper | null>(null);
  const majorRef = useRef<THREE.GridHelper | null>(null);
  // Initialize to the camera's default zoom (50) and derived step (0.5) so
  // the first frame doesn't trigger a throwaway geometry rebuild.
  const lastZoomRef = useRef<number>(50);
  const lastStepRef = useRef<number>(0.5);

  // Build initial helpers with placeholder geometry — replaced in useFrame.
  const minorHelper = useMemo(() => {
    const h = new THREE.GridHelper(2000, 2000, 0x1e2535, 0x1e2535);
    h.rotation.x = Math.PI / 2; // lay flat on XY plane
    h.renderOrder = -1;
    return h;
  }, []);

  const majorHelper = useMemo(() => {
    const h = new THREE.GridHelper(2000, 200, 0x2a3350, 0x2a3350);
    h.rotation.x = Math.PI / 2;
    h.renderOrder = -1;
    return h;
  }, []);

  useEffect(() => {
    return () => {
      minorHelper.geometry.dispose();
      (minorHelper.material as THREE.Material).dispose();
      majorHelper.geometry.dispose();
      (majorHelper.material as THREE.Material).dispose();
    };
  }, [minorHelper, majorHelper]);

  const { camera } = useThree();

  useFrame(() => {
    const ortho = camera as THREE.OrthographicCamera;
    const zoom = ortho.zoom ?? 50;

    const step = adaptiveGridStep(zoom);

    // Rebuild grid geometry only when step changes (avoids per-frame allocs).
    if (step !== lastStepRef.current || zoom !== lastZoomRef.current) {
      lastZoomRef.current = zoom;
      lastStepRef.current = step;

      const majorStep = majorGridStep(step);

      // Grid extent: enough to fill the viewport + some margin.
      // Use a fixed large extent; GridHelper clips to a box anyway.
      const extent = 20000;

      const minorDivisions = Math.round(extent / step);
      const majorDivisions = Math.round(extent / majorStep);

      // Swap geometry in-place: build a scratch helper for the new step,
      // dispose the old geometry, assign the new one, then dispose only the
      // scratch material (the persistent helper owns its own material).

      // Rebuild minor
      const scratchMinor = new THREE.GridHelper(
        extent,
        Math.max(1, minorDivisions),
        0x1e2535,
        0x1e2535,
      );
      scratchMinor.rotation.x = Math.PI / 2;
      if (minorRef.current) {
        minorRef.current.geometry.dispose();
        minorRef.current.geometry = scratchMinor.geometry;
      }
      (scratchMinor.material as THREE.Material).dispose();

      // Rebuild major
      const scratchMajor = new THREE.GridHelper(
        extent,
        Math.max(1, majorDivisions),
        0x2a3350,
        0x2a3350,
      );
      scratchMajor.rotation.x = Math.PI / 2;
      if (majorRef.current) {
        majorRef.current.geometry.dispose();
        majorRef.current.geometry = scratchMajor.geometry;
      }
      (scratchMajor.material as THREE.Material).dispose();
    }

    // Follow the camera XY pan so the grid appears infinite.
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

// ---------------------------------------------------------------------------
// ZoomReader — reads camera zoom each frame and surfaces it to React via a ref+callback
// ---------------------------------------------------------------------------

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
  useEffect(() => { onZoomRef.current = onZoom; }, [onZoom]);

  useFrame(() => {
    const zoom = (camera as THREE.OrthographicCamera).zoom ?? 50;
    if (zoom !== lastZoomRef.current) {
      lastZoomRef.current = zoom;
      onZoomRef.current(zoom);
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------

interface SceneContents2DProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  onClickPoint: (point: Vec2) => void;
  onDoubleClick: () => void;
  onZoom: (zoom: number) => void;
}

function SceneContents2D({
  activeTool,
  collectedPoints,
  onClickPoint,
  onDoubleClick,
  onZoom,
}: SceneContents2DProps): React.ReactElement {
  const document = useStore((s) => s.document);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const isDrawing = activeTool !== 'none';

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
      <OrthographicCamera
        makeDefault
        position={[0, 0, 100]}
        near={0.01}
        far={10000}
        zoom={50}
      />

      {/* ---- Controls: pan + zoom only; disabled while drawing ---- */}
      <MapControls
        makeDefault
        enabled={!isDrawing}
        enableRotate={false}
        screenSpacePanning={true}
        zoomSpeed={1.2}
        panSpeed={1.0}
      />

      {/* ---- Demand-mode invalidation: re-render on store/document changes ---- */}
      <StoreInvalidator2D />

      {/* ---- Per-frame rebase check — keeps float32 coords small ---- */}
      <RenderOriginSyncer2D />

      {/* ---- Zoom reader: surfaces zoom to the HTML ScaleBar overlay ---- */}
      <ZoomReader onZoom={onZoom} />

      {/* ---- Ambient light (flat look for 2D drafting) ---- */}
      <ambientLight intensity={1.0} />

      {/* ---- Adaptive 2D grid on the XY plane ---- */}
      <AdaptiveGrid2D />

      {/* ---- Entities, snap indicator, and draw interaction are all inside
           the same offset group so pointer e.point resolves in document
           space — matching the snap candidate frame (architecture L7).  ---- */}
      <group position={groupOffset}>
        <Entities2D document={document} />

        {/* Snap indicator: shown when no draw tool is active */}
        {!isDrawing && <SnapIndicator />}

        {/* Draw interaction: click-capture + rubber-band preview */}
        <DrawInteraction
          activeTool={activeTool}
          collectedPoints={collectedPoints}
          onClickPoint={onClickPoint}
          onDoubleClick={onDoubleClick}
        />
      </group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Viewport2D — the exported component
// ---------------------------------------------------------------------------

export function Viewport2D(): React.ReactElement {
  const { activeTool, collectedPoints, setActiveTool, handleClick, finishPolyline } =
    useDrawTool();

  const document = useStore((s) => s.document);

  // Camera zoom state — updated by ZoomReader inside the canvas, displayed by
  // ScaleBar outside it. Initial value matches the OrthographicCamera zoom prop.
  const [cameraZoom, setCameraZoom] = useState<number>(50);

  const onDoubleClick = useCallback(() => {
    finishPolyline(false);
  }, [finishPolyline]);

  const handleZoom = useCallback((zoom: number) => {
    setCameraZoom(zoom);
  }, []);

  return (
    <div className="viewport-2d-wrapper" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        frameloop="demand"
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
        orthographic
        style={{ width: '100%', height: '100%', background: '#0e1220' }}
      >
        <Suspense fallback={null}>
          <SceneContents2D
            activeTool={activeTool}
            collectedPoints={collectedPoints}
            onClickPoint={handleClick}
            onDoubleClick={onDoubleClick}
            onZoom={handleZoom}
          />
        </Suspense>
      </Canvas>

      {/* HTML overlay: scale bar (bottom-right) */}
      <ScaleBar zoom={cameraZoom} document={document} />

      {/* HTML tool palette overlaid on top of the canvas */}
      <DrawTools activeTool={activeTool} onSelectTool={setActiveTool} />
    </div>
  );
}
