import type { Constraint, EntityRef } from '../../model/types';
import { cross2 } from '../../lib/vec2';
import { directionOf, lineOf, pointOf, subKindOf, type Layout } from './solver/layout';

const key = (ref: EntityRef): string => `${ref.entityId}:${subKindOf(ref) ?? ''}`;

/** Points joined by `coincident` constraints are one node of the triangle graph. */
function nodeResolver(constraints: readonly Constraint[]): (ref: EntityRef) => string {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k);
    if (p === undefined || p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  for (const c of constraints) if (c.kind === 'coincident') parent.set(find(key(c.a)), find(key(c.b)));
  return (ref) => find(key(ref));
}

/** Signed area of the triangle (twice), at the layout vector `x`. */
function area(layout: Layout, x: Float64Array, refs: readonly [EntityRef, EntityRef, EntityRef]): number {
  const [p, q, r] = refs.map((ref) => pointOf(layout, x, ref) ?? ([0, 0] as const));
  return p && q && r ? cross2([q[0] - p[0], q[1] - p[1]], [r[0] - p[0], r[1] - p[1]]) : 0;
}

/** Triangles whose three sides are all fixed by distance/aligned dimensions, as one reference per corner. */
function dimensionedTriangles(layout: Layout, constraints: readonly Constraint[]): [EntityRef, EntityRef, EntityRef][] {
  const node = nodeResolver(constraints);
  const representative = new Map<string, EntityRef>();
  const edges = new Map<string, Set<string>>();
  const link = (p: EntityRef, q: EntityRef): void => {
    const [np, nq] = [node(p), node(q)];
    if (np === nq) return;
    representative.set(np, representative.get(np) ?? p);
    representative.set(nq, representative.get(nq) ?? q);
    edges.set(np, (edges.get(np) ?? new Set()).add(nq));
    edges.set(nq, (edges.get(nq) ?? new Set()).add(np));
  };
  for (const c of constraints) {
    if (c.kind !== 'distance' && c.kind !== 'aligned') continue;
    const lineForm = c.a.entityId === c.b.entityId && subKindOf(c.a) === undefined && subKindOf(c.b) === undefined;
    if (lineForm && lineOf(layout, layout.x0, c.a.entityId))
      link({ entityId: c.a.entityId, kind: 'start' }, { entityId: c.a.entityId, kind: 'end' });
    else if (!lineForm) link(c.a, c.b);
  }
  const triangles: [EntityRef, EntityRef, EntityRef][] = [];
  for (const [p, neighbours] of edges) {
    for (const q of neighbours) {
      if (q <= p) continue;
      for (const r of edges.get(q) ?? []) {
        const [rp, rq, rr] = [representative.get(p), representative.get(q), representative.get(r)];
        if (r > q && neighbours.has(r) && rp && rq && rr) triangles.push([rp, rq, rr]);
      }
    }
  }
  return triangles;
}

/**
 * Descriptions of sketch features that mirror between `before` and `after` (layout vectors of the same layout): the signed angle between
 * two lines tied by an angle or perpendicular constraint, and the winding of triangles whose three sides are dimensioned.
 * `except` skips the constraint being added: its own sign is the author's declaration, not a regression.
 */
export function findFlips(
  layout: Layout,
  before: Float64Array,
  after: Float64Array,
  constraints: readonly Constraint[],
  except: string | null,
): string[] {
  const flips: string[] = [];
  for (const c of constraints) {
    if (c.id === except || (c.kind !== 'angle' && c.kind !== 'perpendicular')) continue;
    const [a0, b0, a1, b1] = [
      lineOf(layout, before, c.a.entityId),
      lineOf(layout, before, c.b.entityId),
      lineOf(layout, after, c.a.entityId),
      lineOf(layout, after, c.b.entityId),
    ];
    if (!a0 || !b0 || !a1 || !b1) continue;
    const turnBefore = cross2(directionOf(a0), directionOf(b0));
    const turnAfter = cross2(directionOf(a1), directionOf(b1));
    if (turnBefore * turnAfter < 0 && Math.abs(turnBefore) > 0.05 && Math.abs(turnAfter) > 1e-3)
      flips.push(`lines '${c.a.entityId}' and '${c.b.entityId}' (constraint ${c.id}) would swap which side line b lies on`);
  }
  for (const corners of dimensionedTriangles(layout, constraints)) {
    const [areaBefore, areaAfter] = [area(layout, before, corners), area(layout, after, corners)];
    const [p, q, r] = corners.map((ref) => pointOf(layout, before, ref) ?? ([0, 0] as const));
    const longest = Math.max(
      Math.hypot((q?.[0] ?? 0) - (p?.[0] ?? 0), (q?.[1] ?? 0) - (p?.[1] ?? 0)),
      Math.hypot((r?.[0] ?? 0) - (q?.[0] ?? 0), (r?.[1] ?? 0) - (q?.[1] ?? 0)),
    );
    if (areaBefore * areaAfter < 0 && Math.abs(areaBefore) > 0.01 * longest * longest)
      flips.push(`triangle ${corners.map((ref) => key(ref)).join(' / ')} would be mirrored`);
  }
  return flips;
}
