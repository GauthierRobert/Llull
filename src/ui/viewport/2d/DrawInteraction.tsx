// In-Canvas click plane + preview of the active draw tool: snapped clicks → useDrawTool; double-click finishes a
// chain; held Shift = ortho from the last point (also the perpendicular/tangent reference).

import { useState } from 'react';
import { flushSync } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import type { DrawToolKind } from '@ui/store';
import { useZoomSnap } from './useSnap';
import { DrawPreview, CollectedPointMarkers } from './DrawPreview';
import { isChainTool } from './drawToolTable';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

interface DrawInteractionProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  onClickPoint: (point: Vec2) => void;
  onDoubleClick: () => void;
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
  const [orthoHeld, setOrthoHeld] = useState(false);

  const snapResult = useZoomSnap(rawCursor, zoom, collectedPoints.at(-1) ?? null, orthoHeld);
  const snappedCursor: Vec2 | null = snapResult && [snapResult.x, snapResult.y];

  if (activeTool === 'none') return null;

  return (
    <>
      <GroundPlane
        onPointerMove={(e) => {
          e.stopPropagation();
          setOrthoHeld(e.shiftKey);
          setRawCursor(toDocumentPoint(e.point));
        }}
        // Taps have no prior pointermove: take the cursor from the press, flushed synchronously (pointerdown and click
        // arrive within one frame, before an async render commits).
        onPointerDown={(e) => {
          const point = toDocumentPoint(e.point);
          flushSync(() => {
            setOrthoHeld(e.shiftKey);
            setRawCursor(point);
          });
        }}
        onPointerLeave={() => setRawCursor(null)}
        onClick={(e) => {
          e.stopPropagation();
          onClickPoint(snappedCursor ?? toDocumentPoint(e.point));
        }}
        onDoubleClick={(e) => {
          if (!isChainTool(activeTool)) return;
          e.stopPropagation();
          onDoubleClick();
        }}
      />

      <DrawPreview activeTool={activeTool} collectedPoints={collectedPoints} cursor={snappedCursor} zoom={zoom} />

      <CollectedPointMarkers points={collectedPoints} zoom={zoom} />
    </>
  );
}
