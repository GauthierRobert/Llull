/**
 * @layer ui/viewport/3d
 *
 * Camera framing for "Fit all / Fit selection": the centre of the entities' true world AABB and
 * the camera distance that fits its bounding sphere in the perspective frustum.
 */

import type { CadDocument, Entity, Vec3 } from '@core/model/types';
import {
  boundsCenter,
  entityBounds,
  instanceBoundsFromDoc,
  mergeBounds,
} from '@core/commands/sceneBounds';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';

/** Margin applied on top of the exact fit distance. */
const FIT_MARGIN = 1.15;
/** Framed radius for a zero-extent selection (a lone point), so it does not zoom to nothing. */
const DEGENERATE_SPHERE_RADIUS = 1;

export interface FitFraming {
  readonly center: Vec3;
  /** Camera distance from `center`. */
  readonly distance: number;
}

function boundsOf(entity: Entity, document: CadDocument): ReturnType<typeof entityBounds> {
  return entity.kind === 'instance'
    ? instanceBoundsFromDoc(entity, document)
    : entityBounds(entity);
}

/**
 * World AABB of the existing entities among `ids` (instances expanded through their component).
 *
 * @pure
 * @failure no ids, or none that exist -> null
 */
export function mergedEntityBounds(
  document: CadDocument,
  ids: readonly string[],
): ReturnType<typeof entityBounds> | null {
  let merged: ReturnType<typeof entityBounds> | null = null;
  for (const id of ids) {
    const entity = document.entities[id];
    if (!entity) continue;
    const bounds = boundsOf(entity, document);
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

  const extentRadius =
    Math.hypot(
      merged.max[0] - merged.min[0],
      merged.max[1] - merged.min[1],
      merged.max[2] - merged.min[2],
    ) / 2;
  // Real size wins, however small (a 0.02 mm part must fill the view); only a point gets a default.
  const sphereRadius = extentRadius > 0 ? extentRadius : DEGENERATE_SPHERE_RADIUS;
  // The bounding sphere must fit the narrower of the vertical / horizontal half-angles.
  const halfVertical = (VIEWPORT_FOV_DEGREES / 2) * (Math.PI / 180);
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(aspect, 1e-3));
  const halfAngle = Math.min(halfVertical, halfHorizontal);
  return {
    center: boundsCenter(merged),
    distance: (sphereRadius / Math.sin(halfAngle)) * FIT_MARGIN,
  };
}
