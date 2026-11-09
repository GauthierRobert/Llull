/**
 * Contact narrow phase (COR TR-COR-02/03, spec §5.1): classifies two solids as interference / face / edge / vertex contact within a
 * tolerance. Closed form for two unrotated boxes; every other pair is an AABB `possible` contact flagged approximate.
 * Pure geometry, document units; the broad phase is `contactPairs` (it reuses the injected spatial index, no second BVH).
 */

import type { Entity, Vec3 } from '../model/types';
import { isZeroRotation } from '../lib/eulerRotation';
import type { Bounds } from './bounds';
import { packBoxes } from './instanceBvh';
import { type SpatialIndexPort, resolveSpatialIndex } from './spatialIndex';

type ContactKind = 'interference' | 'face' | 'edge' | 'vertex' | 'possible';

export interface ContactPair {
  /** Entity ids, `a < b`; instance children are `<instanceId>/<childId>`. */
  readonly a: string;
  readonly b: string;
  readonly kind: ContactKind;
  /** Document units: separation along the worst axis (0 when touching or overlapping). */
  readonly gap: number;
  /** Document units squared: face contact area; 0 for edge / vertex; null for interference and possible. */
  readonly area: number | null;
  /** Document units cubed: overlap volume of an interference; 0 for face / edge / vertex; null for possible. */
  readonly volume: number | null;
  /** Face contacts only: unit axis normal from `a` toward `b`. */
  readonly normal?: Vec3;
  readonly materials: readonly [string | null, string | null];
  readonly source: 'closed_form' | 'aabb';
  readonly approximate: boolean;
}

/** One solid of the contact query: its id, entity (kind / rotation decide the narrow phase) and world AABB. */
export interface ContactBody {
  readonly id: string;
  readonly entity: Entity;
  readonly bounds: Bounds;
}

const AXES = [0, 1, 2] as const;

const exactBox = (body: ContactBody): boolean => body.entity.kind === 'box' && isZeroRotation(body.entity.rotation);

/** Signed overlap of two AABBs on each axis (negative = separation). */
const overlaps = (a: Bounds, b: Bounds): Vec3 => [
  Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]),
  Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]),
  Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]),
];

const unitAxis = (axis: number, sign: 1 | -1): Vec3 => [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0];

/**
 * Contact of the pair within `tolerance`, or null when they are farther apart. Closed form (§5.1) for two unrotated boxes, else the AABB result.
 * @invariant overlap o_k = min(max) - max(min) per axis; all o_k > tol: interference (V = product); else gap = max(0, -min o_k) <= tol, axes with
 *   o_k <= tol touch: one = face (area = product of the other two overlaps), two = edge, three = vertex
 */
function contactOf(first: ContactBody, second: ContactBody, tolerance: number): ContactPair | null {
  const [a, b] = first.id <= second.id ? [first, second] : [second, first];
  const o = overlaps(a.bounds, b.bounds);
  const gap = Math.max(0, -Math.min(o[0], o[1], o[2]));
  if (gap > tolerance) return null;
  const materials: readonly [string | null, string | null] = [a.entity.materialId ?? null, b.entity.materialId ?? null];
  if (!exactBox(a) || !exactBox(b))
    return { a: a.id, b: b.id, kind: 'possible', gap, area: null, volume: null, materials, source: 'aabb', approximate: true };
  const base = { a: a.id, b: b.id, materials, source: 'closed_form' as const, approximate: false };
  if (o[0] > tolerance && o[1] > tolerance && o[2] > tolerance)
    return { ...base, kind: 'interference', gap: 0, area: null, volume: o[0] * o[1] * o[2] };
  const touching = AXES.filter((axis) => (o[axis] ?? 0) <= tolerance);
  const [first3] = touching;
  if (touching.length === 1 && first3 !== undefined) {
    const others = AXES.filter((axis) => axis !== first3);
    const sign = (b.bounds.min[first3] + b.bounds.max[first3]) / 2 >= (a.bounds.min[first3] + a.bounds.max[first3]) / 2 ? 1 : -1;
    return {
      ...base,
      kind: 'face',
      gap,
      area: others.reduce<number>((product, axis) => product * (o[axis] ?? 0), 1),
      volume: 0,
      normal: unitAxis(first3, sign),
    };
  }
  return { ...base, kind: touching.length === 2 ? 'edge' : 'vertex', gap, area: 0, volume: 0 };
}

export interface NearMiss {
  readonly a: string;
  readonly b: string;
  /** Document units: separation along the worst axis, greater than the tolerance and at most the reach. */
  readonly gap: number;
}

/** Separation of two AABBs along the worst axis (0 when they touch or overlap). */
const separation = (a: Bounds, b: Bounds): number => {
  const o = overlaps(a, b);
  return Math.max(0, -Math.min(o[0], o[1], o[2]));
};

/**
 * Every contact among `bodies` within `tolerance` (sorted by a, b, kind) and every near miss with `tolerance < gap <= reach`. Candidates come from the
 * spatial index (`boxQuery` of each AABB inflated by `reach`), so the cost is O(N log N + k); a pair is reported once.
 * @invariant deterministic: bodies are sorted by id first; the port answers identically to the TypeScript BVH; reach >= tolerance
 */
export function contactPairs(
  bodies: readonly ContactBody[],
  tolerance: number,
  reach: number = tolerance,
  port?: SpatialIndexPort | null,
): { readonly pairs: ContactPair[]; readonly nearMisses: NearMiss[] } {
  const sorted = [...bodies].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const inflated = sorted.map(({ bounds }) => ({
    min: [bounds.min[0] - reach, bounds.min[1] - reach, bounds.min[2] - reach] as Vec3,
    max: [bounds.max[0] + reach, bounds.max[1] + reach, bounds.max[2] + reach] as Vec3,
  }));
  const bvh = resolveSpatialIndex(port).build(packBoxes(inflated));
  const pairs: ContactPair[] = [];
  const nearMisses: NearMiss[] = [];
  sorted.forEach((body, index) => {
    const box = inflated[index];
    if (box === undefined) return;
    for (const other of bvh.boxQuery(box.min, box.max)) {
      const partner = sorted[other];
      if (other <= index || partner === undefined) continue;
      const gap = separation(body.bounds, partner.bounds);
      if (gap > reach) continue;
      const pair = gap <= tolerance ? contactOf(body, partner, tolerance) : null;
      if (pair !== null) pairs.push(pair);
      else nearMisses.push({ a: body.id, b: partner.id, gap });
    }
  });
  return { pairs, nearMisses };
}
