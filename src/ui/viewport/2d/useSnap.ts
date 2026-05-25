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
import type { SnapResult, SnapPoint, CollectOpts, OrthoPolarOpts } from './snapping';

/** Shared empty result — avoids per-render allocation when no cursor snaps apply. */
const NO_CANDIDATES: readonly SnapPoint[] = [];

export interface UseSnapOpts {
  /** Grid cell size in world units. Default 1. */
  gridSize?: number;
  /** Snap tolerance in world units. Default 0.5. */
  tolerance?: number;
  /** Ortho / polar options for the current drawing operation. */
  orthoPolar?: OrthoPolarOpts;
  /**
   * When drawing, the "last placed point" — used as the ortho/polar origin
   * and as the reference point for perpendicular/tangent snaps.
   * If not provided, ortho/polar tracking and perpendicular/tangent snaps are skipped.
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
 *
 * Advanced snaps (perpendicular, tangent) use `drawOrigin` as the reference
 * point; extension and nearest snaps use the adjusted cursor position.
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

  // Apply ortho/polar tracking first (constrains the cursor direction from origin).
  // We need the adjusted cursor before computing advanced snap candidates.
  const adjustedCursor: Vec2 | null = useMemo(() => {
    if (cursor === null) return null;
    if (orthoPolar && drawOrigin != null) {
      return applyOrthoPolar(drawOrigin, cursor, orthoPolar);
    }
    return cursor;
  // orthoPolar is typically a stable literal object from the draw-tool component;
  // depending on object identity is intentional — callers must memoise it or accept
  // the extra (cheap) recompute. Primitive-field deps would require spreading the
  // object here and would be noisier without measurable benefit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, orthoPolar, drawOrigin]);

  // Cursor-INDEPENDENT candidates: endpoint / midpoint / center / intersection
  // (and perpendicular / tangent, which key off drawOrigin, not the cursor).
  // These change only when the entity bag or the draw origin changes — NOT on
  // pointer move — so the heavy pass (including the O(segments²) intersection
  // scan) runs once per document/origin instead of once per mousemove. This is
  // the hot-path fix: hovering the 2D canvas no longer recomputes candidates.
  // extension/nearest are forced off here (they are the only cursor-dependent
  // snap types) and a null cursor is passed so they are skipped entirely.
  const staticCandidates = useMemo(
    () =>
      collectSnapCandidates(
        document,
        { ...collectOpts, extensions: false, nearest: false },
        drawOrigin ?? null,
        null,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document.entities, document.order, collectOpts, drawOrigin],
  );

  // Cursor-DEPENDENT candidates: extension + nearest only. These do follow the
  // cursor, but the pass is cheap (linear in segments, no intersection scan) and
  // is skipped entirely unless a caller opts in — no current caller does.
  const wantExtensions = collectOpts?.extensions === true;
  const wantNearest = collectOpts?.nearest === true;
  const cursorCandidates = useMemo(
    (): readonly SnapPoint[] => {
      if ((!wantExtensions && !wantNearest) || adjustedCursor === null) return NO_CANDIDATES;
      return collectSnapCandidates(
        document,
        {
          endpoints: false,
          midpoints: false,
          centers: false,
          intersections: false,
          perpendiculars: false,
          tangents: false,
          extensions: wantExtensions,
          nearest: wantNearest,
        },
        null,
        adjustedCursor,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document.entities, document.order, wantExtensions, wantNearest, adjustedCursor],
  );

  if (adjustedCursor === null) return null;

  // snap() is order-independent (it ranks by distance then snap-type priority),
  // so the union below is equivalent to the single pre-split collectSnapCandidates call.
  const candidates =
    cursorCandidates.length === 0
      ? staticCandidates
      : [...staticCandidates, ...cursorCandidates];

  return snap(adjustedCursor, candidates, gridSize, tolerance);
}
