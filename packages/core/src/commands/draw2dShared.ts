import type { CadDocument, Vec2, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import type { z } from './schema';
import { looseVec3 } from './schema';
import { nextId } from '../lib/id';
import { commitEntity } from './commitEntity';
import { noop } from './noop';
import { newEntity } from './newEntity';

/** Default stroke color of every drafted 2D shape. */
export const DEFAULT_DRAW_COLOR = '#4a90d9';

/** Optional `position` param: where the 2D work plane's origin sits in world space. */
export function workPlanePositionField(): z.ZodOptional<z.ZodType<Vec3>> {
  return looseVec3(
    'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
  ).optional();
}

const POINT_SERIES_ID_PREFIX = { polyline: 'poly', spline: 'spline' } as const;

/**
 * Body of `draw_polyline` / `draw_spline`: an unrotated `kind` entity through `points` (components beyond
 * [x, y] ignored, missing ones read as 0).
 * @failure fewer than 2 points -> no-op, affected:[]
 * @pure
 */
export function drawPointSeries(
  doc: CadDocument,
  kind: 'polyline' | 'spline',
  points: ReadonlyArray<ReadonlyArray<number>>,
  closed: boolean,
  position: Vec3,
  color: string,
): CommandResult {
  if (points.length < 2) {
    return noop(doc, `draw_${kind}: requires at least 2 points (got ${points.length}).`);
  }
  const id = nextId(POINT_SERIES_ID_PREFIX[kind]);
  const entity = newEntity(
    kind,
    id,
    { points: points.map(([x, y]): Vec2 => [x ?? 0, y ?? 0]), closed },
    position,
    color,
  );
  return commitEntity(
    doc,
    entity,
    `Drew ${kind} ${id} with ${points.length} points${closed ? ' (closed)' : ''}.`,
  );
}
