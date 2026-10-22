// Pick post-processing: occlusion of back-side vertices / edges, and loop / ring expansion of an edge. Pure.

import type { SubdivisionEntity } from '@core/model/types';
import type { CagePick } from '@core/geometry/subd/pick';
import { edgeIdOf } from '@core/geometry/subd/elements';
import { isRingProblem, walkRing, edgeLoop } from '@core/geometry/subd/loops';
import { buildTopology } from '@core/geometry/subd/topology';
import { parseEdgeId } from './cageSelection';

/** Drop vertex / edge hits that lie behind the nearest face along the ray by more than `tolerance` (ray-parameter units). */
export function withoutOccluded(pick: CagePick, tolerance: number): CagePick {
  const face = pick.face;
  if (face === null) return pick;
  const hidden = (t: number | undefined): boolean => t !== undefined && t > face.distance + tolerance;
  return { ...pick, vertex: hidden(pick.vertex?.t) ? null : pick.vertex, edge: hidden(pick.edge?.t) ? null : pick.edge };
}

/** Ids of the edge loop through `edgeId` (or, with `ring`, the edges crossed by its quad strip); empty when unknown or the ring breaks. */
export function loopEdgeIds(entity: SubdivisionEntity, edgeId: string, ring: boolean): string[] {
  const ends = parseEdgeId(edgeId);
  if (ends === null) return [];
  const [a, b] = [entity.elementIds.vertices.indexOf(ends[0]), entity.elementIds.vertices.indexOf(ends[1])];
  if (a < 0 || b < 0) return [];
  const topology = buildTopology(entity.vertices.length, entity.faces);
  if (!ring) return edgeLoop(topology, a, b).map(([x, y]) => edgeIdOf(entity.elementIds, x, y));
  const strip = walkRing(topology, a, b);
  return isRingProblem(strip) ? [] : strip.edges.map(([x, y]) => edgeIdOf(entity.elementIds, x, y));
}
