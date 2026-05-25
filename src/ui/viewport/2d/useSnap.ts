/**
 * @layer ui/viewport/2d
 *
 * React hook: converts a raw cursor world position into a snapped position
 * by calling the pure helpers in snapping.ts against the live document.
 *
 * Deliberately thin — just wires the store read + pure helpers together.
 * No document mutation, no side effects (R1, R2).
 */

import { useMemo } from 'react';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import {
  collectSnapCandidates,
  snap,
  applyOrthoPolar,
} from './snapping';
import type { SnapResult, CollectOpts, OrthoPolarOpts } from './snapping';

export interface UseSnapOpts {
  /** Grid cell size in world units. Default 1. */
  gridSize?: number;
  /** Snap tolerance in world units. Default 0.5. */
  tolerance?: number;
  /** Ortho / polar options for the current drawing operation. */
  orthoPolar?: OrthoPolarOpts;
  /**
   * When drawing, the "last placed point" — used as the ortho/polar origin.
   * If not provided, ortho/polar tracking is skipped even when enabled.
   */
  drawOrigin?: Vec2 | null;
  /** Override which snap types are collected. All enabled by default. */
  collectOpts?: CollectOpts;
}

/**
 * Given a raw cursor position in world 2D coords, returns the snapped result.
 *
 * Memoizes the candidate list on document.order + document.entities identity
 * (changes only when the document entity bag changes).
 */
export function useSnap(cursor: Vec2 | null, opts: UseSnapOpts = {}): SnapResult | null {
  const document = useStore((s) => s.document);

  const {
    gridSize = 1,
    tolerance = 0.5,
    orthoPolar,
    drawOrigin,
    collectOpts,
  } = opts;

  // Recompute snap candidates only when entities change.
  const candidates = useMemo(
    () => collectSnapCandidates(document, collectOpts ?? {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document.entities, document.order, collectOpts],
  );

  if (cursor === null) return null;

  // Apply ortho/polar tracking first (constrains the cursor direction from origin).
  let adjustedCursor: Vec2 = cursor;
  if (orthoPolar && drawOrigin != null) {
    adjustedCursor = applyOrthoPolar(drawOrigin, cursor, orthoPolar);
  }

  return snap(adjustedCursor, candidates, gridSize, tolerance);
}
