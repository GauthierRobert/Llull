/**
 * The TIN of a surface object, memoized on the (immutable) surface and point-group objects.
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec3 } from '@core/model/types';
import type { CivilModel, PointGroupObject, SurfaceObject } from '@core/model/civil';
import { buildTin, type Tin } from './tin';
import { civilObject } from './model';

interface Memo {
  readonly groups: ReadonlyArray<PointGroupObject | undefined>;
  readonly tin: Tin;
}

const memo = new WeakMap<SurfaceObject, Memo>();

/** Every source point of `surface`: its point groups' points, then its extra points. */
export function surfacePoints(civil: CivilModel, surface: SurfaceObject): Vec3[] {
  const points: Vec3[] = [];
  for (const groupId of surface.pointGroupIds) {
    const group = civilObject(civil, groupId, 'pointGroup');
    for (const point of group?.points ?? []) points.push(point.position);
  }
  return [...points, ...surface.extraPoints];
}

export function surfaceTin(civil: CivilModel, surface: SurfaceObject): Tin {
  const groups = surface.pointGroupIds.map((id) => civilObject(civil, id, 'pointGroup'));
  const cached = memo.get(surface);
  if (
    cached &&
    cached.groups.length === groups.length &&
    cached.groups.every((group, index) => group === groups[index])
  ) {
    return cached.tin;
  }
  const tin = buildTin(surfacePoints(civil, surface), {
    ...(surface.boundary !== undefined ? { boundary: surface.boundary } : {}),
    ...(surface.maxEdgeLength !== undefined ? { maxEdgeLength: surface.maxEdgeLength } : {}),
  });
  memo.set(surface, { groups, tin });
  return tin;
}

/** The TIN of surface `surfaceId`, or null when it is not a surface. */
export function surfaceTinById(civil: CivilModel, surfaceId: string): Tin | null {
  const surface = civilObject(civil, surfaceId, 'surface');
  return surface ? surfaceTin(civil, surface) : null;
}
