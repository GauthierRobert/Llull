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
 * Double-click finishes a polyline, spline or wall chain. Holding Shift constrains to ortho.
 *
 * Presentation only — no document mutations (R1).
 */

import { useState } from 'react';
import type { Vec2 } from '@core/model/types';
import type { DrawToolKind } from '@ui/store';
import { useZoomSnap } from './useSnap';
import { DrawPreview, CollectedPointMarkers } from './DrawPreview';
import { CHAIN_DRAW_TOOLS } from './drawHelpers';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

interface DrawInteractionProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  onClickPoint: (point: Vec2) => void;
  onDoubleClick: () => void;
  /** Current ortho camera zoom — drives the adaptive snap grid + tolerance. */
  zoom: number;
}

export function DrawInteraction({
  activeTool,
  collectedPoints,
  onClickPoint,
  onDoubleClick,
  zoom,
}: DrawInteractionProps): React.ReactElement | null {
  const [rawCursor, setRawCursor] = useState<Vec2 | null>(null);
  // Holding Shift constrains the next point to the horizontal/vertical from the last one.
  const [orthoHeld, setOrthoHeld] = useState(false);

  // The last placed point is the reference for perpendicular/tangent snaps.
  const snapResult = useZoomSnap(rawCursor, zoom, collectedPoints.at(-1) ?? null, orthoHeld);
  const snappedCursor: Vec2 | null = snapResult && [snapResult.x, snapResult.y];

  // If no draw tool is active, don't intercept events.
  if (activeTool === 'none') return null;

  return (
    <>
      <GroundPlane
        onPointerMove={(e) => {
          e.stopPropagation();
          setOrthoHeld(e.shiftKey);
          setRawCursor(toDocumentPoint(e.point));
        }}
        // Touch/pen taps deliver no preceding pointermove: take the cursor from the press so the
        // click lands where the pointer is, not at the last hover position.
        onPointerDown={(e) => {
          setOrthoHeld(e.shiftKey);
          setRawCursor(toDocumentPoint(e.point));
        }}
        onPointerLeave={() => setRawCursor(null)}
        onClick={(e) => {
          e.stopPropagation();
          onClickPoint(snappedCursor ?? toDocumentPoint(e.point));
        }}
        onDoubleClick={(e) => {
          if (!CHAIN_DRAW_TOOLS.has(activeTool)) return;
          e.stopPropagation();
          onDoubleClick();
        }}
      />

      <DrawPreview
        activeTool={activeTool}
        collectedPoints={collectedPoints}
        cursor={snappedCursor}
      />

      <CollectedPointMarkers points={collectedPoints} />
    </>
  );
}
