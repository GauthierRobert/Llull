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

/** Half the default three.js PerspectiveCamera FOV (75 degrees). */
const HALF_FOV_TAN = Math.tan((75 / 2) * (Math.PI / 180));
/** Margin applied on top of the exact fit distance. */
const FIT_MARGIN = 1.35;
/** Smallest framed sphere radius, so a point-like selection does not zoom to nothing. */
const MIN_SPHERE_RADIUS = 1;

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
 * @failure no ids, or none that exist -> null
 */
export function computeFitFraming(
  document: CadDocument,
  ids: readonly string[],
): FitFraming | null {
  const merged = mergedEntityBounds(document, ids);
  if (!merged) return null;

  const sphereRadius = Math.max(
    Math.hypot(
      merged.max[0] - merged.min[0],
      merged.max[1] - merged.min[1],
      merged.max[2] - merged.min[2],
    ) / 2,
    MIN_SPHERE_RADIUS,
  );
  return { center: boundsCenter(merged), distance: (sphereRadius / HALF_FOV_TAN) * FIT_MARGIN };
}
