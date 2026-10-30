/**
 * Global self-overlap of a sweep (02 SWG, DES-2c): a path that comes back through its own tube (a crossing, a loop) passes every local fold test and
 * the volume check alike (the exact kernel integrates the overlapping region twice, as the section-times-path integral does: §16.4). The welded
 * display triangles are searched for crossing pairs instead.
 */

import type { SweepEntity } from '../../model/types';
import { sweepTriangles } from '../../geometry/sweep';
import { findSelfIntersections } from '../../geometry/mesh/selfIntersection';
import { weldMesh } from '../../geometry/mesh/weld';
import { REMEDIATION, type Finding } from './checkFindings';

/** Named guard: display triangles above which the pair search is skipped (an info finding says so), as for the deform overlap check. */
export const OVERLAP_CHECK_TRIANGLES = 60_000;

/** A fail finding when the sweep's tessellation crosses itself, an info finding when it is too large to search, else null. */
export function checkOverlap(entity: SweepEntity, unit: string): Finding | null {
  const triangles = sweepTriangles(entity);
  if (triangles.length > OVERLAP_CHECK_TRIANGLES)
    return {
      code: 'SWG_CHECK_SELF_INTERSECTION_GLOBAL',
      severity: 'info',
      entityId: entity.id,
      value: triangles.length,
      limit: OVERLAP_CHECK_TRIANGLES,
      unit: 'triangles',
      remediation: 'none: the overlap search was skipped above the triangle limit',
      message: `overlap not searched: ${triangles.length} display triangles (limit ${OVERLAP_CHECK_TRIANGLES})`,
    };
  const positions = triangles.flatMap((triangle) => triangle.flat());
  const soup = { positions, indices: Array.from({ length: positions.length / 3 }, (_, index) => index) };
  let [low, high] = [Infinity, -Infinity];
  for (const value of positions) [low, high] = [Math.min(low, value), Math.max(high, value)];
  const welded = weldMesh(soup, 1e-7 * Math.max(1, high - low));
  const crossings = findSelfIntersections(welded.positions, welded.triangles, 1).count;
  if (crossings === 0) return null;
  return {
    code: 'SWG_CHECK_SELF_INTERSECTION_GLOBAL',
    severity: 'fail',
    entityId: entity.id,
    value: crossings,
    limit: 0,
    unit: `triangle pairs (${unit} model)`,
    remediation: REMEDIATION.SWG_CHECK_SELF_INTERSECTION_GLOBAL as string,
    message: `the sweep passes through itself: ${crossings} crossing triangle pair(s) of its tessellation (a path crossing or looping back within the section)`,
  };
}
