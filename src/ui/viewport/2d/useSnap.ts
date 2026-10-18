// Raw cursor → snapped world point against the live, visible document (pure snapping/ helpers, no mutation).

import { useMemo } from 'react';
import type { Vec2 } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { snap, applyOrthoPolar } from './snapping/resolveSnap';
import { sharedSnapCandidates } from './snapping/sharedCandidates';
import { useSectionCutDepth } from './sectionCut';
import { adaptiveGridStep, pixelsToWorld } from './gridHelpers';
import type { SnapResult, OrthoPolarOpts } from './snapping/types';

const ORTHO_ONLY: OrthoPolarOpts = { ortho: true, polar: false };
/** Aperture constant on screen across zoom (CAD convention). */
const SNAP_TOLERANCE_PX = 12;

/**
 * Snap for the ortho 2D view at camera `zoom`: grid = the visible adaptive grid step, aperture pixel-constant.
 * `drawOrigin` (last placed point) is the ortho origin and the perpendicular/tangent reference; `ortho` (held Shift)
 * constrains the cursor horizontal/vertical from it.
 */
export function useZoomSnap(cursor: Vec2 | null, zoom: number, drawOrigin: Vec2 | null = null, ortho = false): SnapResult | null {
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  const components = useStore((s) => s.document.components);
  const cutDepth = useSectionCutDepth();
  const layers = useStore((s) => s.document.layers);
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);

  const adjustedCursor = useMemo(
    (): Vec2 | null => (cursor === null ? null : ortho && drawOrigin !== null ? applyOrthoPolar(drawOrigin, cursor, ORTHO_ONLY) : cursor),
    [cursor, ortho, drawOrigin],
  );

  // Cursor-independent (extension/nearest off): computed once per document/origin and shared across hooks (selection-only changes hit the cache).
  const candidates = useMemo(
    () =>
      sharedSnapCandidates({ document: { entities, order, components, layers }, hiddenLayerIds, hiddenEntityIds, drawOrigin, cutDepth }),
    [entities, order, components, layers, hiddenLayerIds, hiddenEntityIds, drawOrigin, cutDepth],
  );

  return adjustedCursor === null ? null : snap(adjustedCursor, candidates, adaptiveGridStep(zoom), pixelsToWorld(SNAP_TOLERANCE_PX, zoom));
}
