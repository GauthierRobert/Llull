import type { CadDocument, Entity, Vec2, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { z } from './schema';
import { looseVec3 } from './schema';
import { noOp } from './commandResult';

/** Default stroke color of every drafted 2D shape. */
export const DEFAULT_DRAW_COLOR = '#4a90d9';

/** Optional `position` param: where the 2D work plane's origin sits in world space. */
export function workPlanePositionField(): z.ZodOptional<z.ZodType<Vec3>> {
  return looseVec3(
    'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
  ).optional();
}

/**
 * Unrotated polyline/spline entity through `points` (components beyond [x, y] ignored; missing
 * coordinates read as 0).
 * @pure
 */
export function pointSeriesEntity(
  kind: 'polyline' | 'spline',
  id: string,
  points: readonly unknown[],
  closed: boolean,
  position: Vec3,
  color: string,
): Entity {
  const safePoints: ReadonlyArray<Vec2> = points.map(
    (p) => [(p as number[])[0] ?? 0, (p as number[])[1] ?? 0] as Vec2,
  );
  return {
    id,
    kind,
    points: safePoints,
    closed,
    position,
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color,
  };
}

/** Format a number compactly for the summary string. */
export function fmtN(v: number): string {
  return parseFloat(v.toFixed(4)).toString();
}

/** No-op result when `points` is not an array of at least 2 points, else `null`. */
export function rejectTooFewPoints(
  doc: CadDocument,
  command: string,
  points: unknown,
): CommandResult | null {
  if (Array.isArray(points) && points.length >= 2) return null;
  return noOp(
    doc,
    `${command}: requires at least 2 points (got ${Array.isArray(points) ? points.length : 0}).`,
  );
}
