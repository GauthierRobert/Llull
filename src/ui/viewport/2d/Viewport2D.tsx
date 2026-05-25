/**
 * @layer ui/viewport/2d
 *
 * The 2D orthographic drafting viewport.
 *
 * - A single r3f <Canvas> with an OrthographicCamera looking straight down the
 *   -Z axis onto the XY plane (top-down drafting view).
 * - MapControls (drei) for 2D-appropriate pan + zoom (rotation disabled).
 *   Controls are disabled while a draw tool is active so clicks are not
 *   misinterpreted as panning.
 * - A 2D reference grid on the XY plane.
 * - Entities2D renders all 2D shape entities from the document.
 * - DrawInteraction handles click-capture + rubber-band preview for draw tools.
 * - DrawTools is an HTML overlay palette for tool selection.
 *
 * Purely presentational: reads from the store, never mutates the document
 * (PRIME DIRECTIVE). All changes go through dispatch.
 */

import { Suspense, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrthographicCamera, MapControls, Grid } from '@react-three/drei';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import { Entities2D } from './Entities2D';
import { SnapIndicator } from './SnapIndicator';
import { DrawInteraction } from './DrawInteraction';
import { DrawTools } from './DrawTools';
import { useDrawTool } from './useDrawTool';
import type { DrawToolKind } from './useDrawTool';

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------

interface SceneContents2DProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  onClickPoint: (point: Vec2) => void;
  onDoubleClick: () => void;
}

function SceneContents2D({
  activeTool,
  collectedPoints,
  onClickPoint,
  onDoubleClick,
}: SceneContents2DProps): React.ReactElement {
  const document = useStore((s) => s.document);
  const isDrawing = activeTool !== 'none';

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

      {/* ---- Ambient light (flat look for 2D drafting) ---- */}
      <ambientLight intensity={1.0} />

      {/* ---- 2D reference grid on the XY plane ---- */}
      <Grid
        args={[200, 200]}
        cellSize={1}
        cellThickness={0.4}
        cellColor="#1e2535"
        sectionSize={10}
        sectionThickness={0.8}
        sectionColor="#2a3350"
        fadeDistance={400}
        fadeStrength={1}
        position={[0, 0, -0.01]}
        rotation={[Math.PI / 2, 0, 0]}
      />

      {/* ---- 2D entities ---- */}
      <Entities2D document={document} />

      {/* ---- Snap indicator: shown when no draw tool is active ---- */}
      {!isDrawing && <SnapIndicator />}

      {/* ---- Draw interaction: click-capture + rubber-band preview ---- */}
      <DrawInteraction
        activeTool={activeTool}
        collectedPoints={collectedPoints}
        onClickPoint={onClickPoint}
        onDoubleClick={onDoubleClick}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Viewport2D — the exported component
// ---------------------------------------------------------------------------

export function Viewport2D(): React.ReactElement {
  const { activeTool, collectedPoints, setActiveTool, handleClick, finishPolyline } =
    useDrawTool();

  const onDoubleClick = useCallback(() => {
    finishPolyline(false);
  }, [finishPolyline]);

  return (
    <div className="viewport-2d-wrapper" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
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
          />
        </Suspense>
      </Canvas>

      {/* HTML tool palette overlaid on top of the canvas */}
      <DrawTools activeTool={activeTool} onSelectTool={setActiveTool} />
    </div>
  );
}
