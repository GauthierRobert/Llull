/**
 * @layer ui/viewport/2d
 *
 * Click-capture plane + preview compositor for the active draw tool.
 *
 * Mounted inside the r3f Canvas. Renders:
 *   1. An invisible plane that captures pointer events (world-space coords).
 *   2. DrawPreview (rubber-band geometry following the snapped cursor).
 *   3. CollectedPointMarkers (dots at already-placed vertices).
 *
 * Snapping is applied via useSnap before forwarding to useDrawTool.handleClick.
 * Double-click finishes a polyline or spline.
 *
 * Presentation only — no document mutations (R1).
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import { useSnap } from './useSnap';
import { DrawPreview, CollectedPointMarkers } from './DrawPreview';
import type { DrawToolKind } from './useDrawTool';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DrawInteractionProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  onClickPoint: (point: Vec2) => void;
  onDoubleClick: () => void;
}

// ---------------------------------------------------------------------------
// DrawInteraction
// ---------------------------------------------------------------------------

export function DrawInteraction({
  activeTool,
  collectedPoints,
  onClickPoint,
  onDoubleClick,
}: DrawInteractionProps): React.ReactElement | null {
  const [rawCursor, setRawCursor] = useState<Vec2 | null>(null);

  // Last placed point (for ortho/polar tracking).
  const drawOrigin: Vec2 | null =
    collectedPoints.length > 0 ? collectedPoints[collectedPoints.length - 1]! : null;

  // Snap the cursor with ortho/polar awareness.
  const snapResult = useSnap(rawCursor, {
    gridSize: 1,
    tolerance: 0.5,
    drawOrigin,
  });

  const snappedCursor: Vec2 | null = useMemo<Vec2 | null>(
    () => (snapResult !== null ? [snapResult.x, snapResult.y] : null),
    [snapResult],
  );

  // Invisible ground-plane geometry (shared with SnapIndicator but separate instance).
  const geo = useMemo(() => new THREE.PlaneGeometry(100000, 100000), []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    [],
  );

  useEffect(() => {
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

  const handleMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (activeTool === 'none') return;
      e.stopPropagation();
      setRawCursor([e.point.x, e.point.y]);
    },
    [activeTool],
  );

  const handleLeave = useCallback(() => {
    setRawCursor(null);
  }, []);

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (activeTool === 'none') return;
      e.stopPropagation();
      const pt: Vec2 = snappedCursor ?? [e.point.x, e.point.y];
      onClickPoint(pt);
    },
    [activeTool, snappedCursor, onClickPoint],
  );

  const handleDoubleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (activeTool !== 'polyline' && activeTool !== 'spline') return;
      e.stopPropagation();
      onDoubleClick();
    },
    [activeTool, onDoubleClick],
  );

  // If no draw tool is active, don't intercept events.
  if (activeTool === 'none') return null;

  return (
    <>
      <mesh
        geometry={geo}
        material={mat}
        position={[0, 0, 0]}
        onPointerMove={handleMove}
        onPointerLeave={handleLeave}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      />

      <DrawPreview activeTool={activeTool} collectedPoints={collectedPoints} cursor={snappedCursor} />

      <CollectedPointMarkers points={collectedPoints} />
    </>
  );
}
