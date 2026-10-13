/**
 * @layer ui/viewport/3d
 *
 * Camera framing for "Fit all / Fit selection": the centre of the entities' true world AABB and
 * the camera distance that fits its bounding sphere in the perspective frustum.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { type Bounds, entityBoundsInDoc, mergeBounds } from '@core/geometry/bounds';
import { fitFraming } from '@core/geometry/viewFraming';

/** Margin applied on top of the exact fit distance. */
const FIT_MARGIN = 1.15;
/** Framed radius for a zero-extent selection (a lone point), so it does not zoom to nothing. */
const DEGENERATE_SPHERE_RADIUS = 1;

export interface FitFraming {
  readonly center: Vec3;
  /** Camera distance from `center`. */
  readonly distance: number;
}

/**
 * World AABB of the existing entities among `ids` (instances expanded through their component,
 * dimensions framed with the geometry they measure) — the same bounds `fit_view` uses.
 *
 * @pure
 * @failure no ids, or none that exist -> null
 */
export function mergedEntityBounds(document: CadDocument, ids: readonly string[]): Bounds | null {
  let merged: Bounds | null = null;
  for (const id of ids) {
    const entity = document.entities[id];
    if (!entity) continue;
    const bounds = entityBoundsInDoc(document, entity);
    merged = merged ? mergeBounds(merged, bounds) : bounds;
  }
  return merged;
}

/**
 * @pure
 * @param aspect viewport width / height (default square)
 * @failure no ids, or none that exist -> null
 */
export function computeFitFraming(
  document: CadDocument,
  ids: readonly string[],
  aspect = 1,
): FitFraming | null {
  const merged = mergedEntityBounds(document, ids);
  if (!merged) return null;

  // Real size wins, however small (a 0.02 mm part must fill the view); only a point gets a default.
  return fitFraming(merged, aspect, FIT_MARGIN, {
    degenerateBelow: 0,
    degenerateRadius: DEGENERATE_SPHERE_RADIUS,
  });
}
