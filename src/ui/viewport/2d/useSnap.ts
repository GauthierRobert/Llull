/**
 * @layer ui/viewport/2d
 *
 * React hook: converts a raw cursor world position into a snapped position by calling the
 * pure helpers in snapping/ against the live document. Deliberately thin — no document
 * mutation, no side effects (R1, R2).
 */

import { useCallback, useMemo } from 'react';
import type { Entity, Vec2 } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityVisible } from '../entityVisibility';
import { snap, applyOrthoPolar } from './snapping/resolveSnap';
import { collectSnapCandidates } from './snapping/candidates';
import { adaptiveGridStep, pixelsToWorld } from './gridHelpers';
import type { SnapResult, SnapPoint, CollectOpts, OrthoPolarOpts } from './snapping/types';

/** Shared empty result — avoids per-render allocation when no cursor snaps apply. */
const NO_CANDIDATES: readonly SnapPoint[] = [];

interface UseSnapOpts {
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
function useSnap(cursor: Vec2 | null, opts: UseSnapOpts = {}): SnapResult | null {
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  const components = useStore((s) => s.document.components);
  const layers = useStore((s) => s.document.layers);
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  // Hidden geometry must not attract snaps.
  const isVisible = useCallback(
    (entity: Entity): boolean => isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds),
    [layers, hiddenLayerIds, hiddenEntityIds],
  );

  const { gridSize = 1, tolerance = 0.5, orthoPolar, drawOrigin, collectOpts } = opts;

  // Apply ortho/polar tracking first (constrains the cursor direction from origin).
  // We need the adjusted cursor before computing advanced snap candidates.
  const adjustedCursor: Vec2 | null = useMemo(() => {
    if (cursor === null) return null;
    if (orthoPolar && drawOrigin != null) return applyOrthoPolar(drawOrigin, cursor, orthoPolar);
    return cursor;
    // orthoPolar is compared by identity: callers must memoise it or accept a cheap recompute.
  }, [cursor, orthoPolar, drawOrigin]);

  // Cursor-INDEPENDENT candidates: endpoint / midpoint / center / intersection
  // (and perpendicular / tangent, which key off drawOrigin, not the cursor).
  // These change only when the entity bag or the draw origin changes — NOT on
  // pointer move — so the heavy pass (including the O(segments²) intersection
  // scan) runs once per document/origin instead of once per mousemove: hovering the 2D
  // canvas does not recompute candidates.
  // extension/nearest are forced off here (they are the only cursor-dependent
  // snap types) and a null cursor is passed so they are skipped entirely.
  const staticCandidates = useMemo(
    () =>
      collectSnapCandidates(
        { entities, order, components },
        { ...collectOpts, extensions: false, nearest: false, isVisible },
        drawOrigin ?? null,
        null,
      ),
    [entities, order, components, collectOpts, drawOrigin, isVisible],
  );

  // Cursor-DEPENDENT candidates: extension + nearest only. These do follow the
  // cursor, but the pass is cheap (linear in segments, no intersection scan) and
  // is skipped entirely unless a caller opts in — no current caller does.
  const wantExtensions = collectOpts?.extensions === true;
  const wantNearest = collectOpts?.nearest === true;
  const cursorCandidates = useMemo((): readonly SnapPoint[] => {
    if ((!wantExtensions && !wantNearest) || adjustedCursor === null) return NO_CANDIDATES;
    return collectSnapCandidates(
      { entities, order },
      {
        endpoints: false,
        midpoints: false,
        centers: false,
        intersections: false,
        perpendiculars: false,
        tangents: false,
        extensions: wantExtensions,
        nearest: wantNearest,
        isVisible,
      },
      null,
      adjustedCursor,
    );
  }, [entities, order, wantExtensions, wantNearest, adjustedCursor, isVisible]);

  if (adjustedCursor === null) return null;

  // snap() is order-independent (it ranks by distance then snap-type priority),
  // so the union below is equivalent to the single pre-split collectSnapCandidates call.
  const candidates =
    cursorCandidates.length === 0 ? staticCandidates : [...staticCandidates, ...cursorCandidates];

  return snap(adjustedCursor, candidates, gridSize, tolerance);
}

/** Stable identity so useSnap's memo is not rebuilt every render. */
const ORTHO_ONLY: OrthoPolarOpts = { ortho: true, polar: false };

/** Snap aperture in screen pixels — kept constant across zoom (CAD convention). */
const SNAP_TOLERANCE_PX = 12;

/**
 * `useSnap` for the ortho 2D view at camera `zoom`: the snap grid tracks the visible adaptive mesh
 * (selectable grid points at every zoom) and the aperture is pixel-constant, so geometric snaps
 * stay grabbable from very zoomed out to very zoomed in. `ortho` constrains the cursor to the
 * horizontal/vertical from `drawOrigin` (held Shift while drawing).
 */
export function useZoomSnap(
  cursor: Vec2 | null,
  zoom: number,
  drawOrigin: Vec2 | null = null,
  ortho = false,
): SnapResult | null {
  return useSnap(cursor, {
    gridSize: adaptiveGridStep(zoom),
    tolerance: pixelsToWorld(SNAP_TOLERANCE_PX, zoom),
    drawOrigin,
    ...(ortho ? { orthoPolar: ORTHO_ONLY } : {}),
  });
}
