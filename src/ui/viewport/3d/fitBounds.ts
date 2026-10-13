// Fit all / fit selection: centre of the true world AABB + the distance fitting its bounding sphere in the frustum.

import type { CadDocument, Vec3 } from '@core/model/types';
import { type Bounds, entityBoundsInDoc, mergeBounds } from '@core/geometry/bounds';
import { fitFraming } from '@core/geometry/viewFraming';

const FIT_MARGIN = 1.15;
/** Framed radius of a zero-extent selection (a lone point). */
const DEGENERATE_SPHERE_RADIUS = 1;

export interface FitFraming {
  readonly center: Vec3;
  readonly distance: number;
}

/** Same bounds as `fit_view` (instances through their component, dimensions with what they measure). @failure no existing ids -> null */
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

/** `aspect` = width / height. @failure no existing ids -> null */
export function computeFitFraming(document: CadDocument, ids: readonly string[], aspect = 1): FitFraming | null {
  const merged = mergedEntityBounds(document, ids);
  if (!merged) return null;

  // Real size wins, however small (a 0.02 mm part must fill the view); only a point gets a default.
  return fitFraming(merged, aspect, FIT_MARGIN, { degenerateBelow: 0, degenerateRadius: DEGENERATE_SPHERE_RADIUS });
}
