/**
 * Voronoi (stochastic) beam lattice (05 IMP FR-IMP-19, M6): the edges of the Voronoi diagram of a seeded point set, clipped to a box. The points come from a
 * seeded mulberry32 generator in the box grown by 1.2 mean spacings (so cells at the box wall are complete), the diagram from a Bowyer-Watson Delaunay
 * tetrahedralisation (a Voronoi edge joins the circumcentres of two tetrahedra that share a face).
 * @invariant the diagram is the exact Delaunay dual (exact predicates, 14.14); a seed at exactly the place of an earlier one adds no cell and is counted in dropped
 * @invariant deterministic: the same (box, density, seed) gives the same beams on every machine (no Math.random, no clock, integer-seeded generator, fixed insertion order)
 * @invariant hull tetrahedra (those touching the enclosing tetrahedron) are dropped, so every kept edge has two interior ends; edges are cut to the box (Liang-Barsky)
 */

import type { StrutBeam } from '@core/geometry/field/program';
import type { Vec3 } from '@core/model/types';
import type { GraphResult } from './graph';
import type { VoronoiNode } from './model';
import { type Tet, delaunay, faceKey, facesOf } from './voronoiDelaunay';

/** Seeds beyond this are refused: the Delaunay pass takes 2.4 s for 100000 seeds (14.16) and a seed adds about 9.2 beams (measured), so 100000 seeds give about 1000000 beams, the beam cap below. */
const MAX_SEEDS = 100_000;
/** Beams beyond this are refused (IMP_GRAPH_TOO_LARGE): the native field engine realises 1000000 beams in 15 s at a coarse voxel (14.16). */
const MAX_VORONOI_BEAMS = 1_000_000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Part of segment a-b inside the box (Liang-Barsky slabs), or null. A segment parallel to a slab gives infinite slab times (or NaN on its plane), which the
 * final test rejects or keeps without a special case.
 */
function clipSegment(a: Vec3, b: Vec3, min: Vec3, max: Vec3): [Vec3, Vec3] | null {
  let [t0, t1] = [0, 1];
  for (let axis = 0; axis < 3; axis += 1) {
    const [p, q] = [a[axis] as number, (b[axis] as number) - (a[axis] as number)];
    const [ta, tb] = [((min[axis] as number) - p) / q, ((max[axis] as number) - p) / q];
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (!(t0 < t1)) return null;
  const at = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return [at(t0), at(t1)];
}

type VoronoiParams = Pick<VoronoiNode, 'min' | 'max' | 'density' | 'seed' | 'radius' | 'cap'>;

/** The last result: the command validates the node by compiling it, and a body compiles it again, with the very same parameters (the function is pure, the result is never mutated). */
let last: { key: string; result: GraphResult } | null = null;

/** Beams of the Voronoi lattice of `node` (the last result is reused for equal parameters). */
export function voronoiGeometry(node: VoronoiParams): GraphResult {
  const key = JSON.stringify([node.min, node.max, node.density, node.seed, node.radius, node.cap]);
  if (last !== null && last.key === key) return last.result;
  const result = buildVoronoi(node);
  last = { key, result };
  return result;
}

function buildVoronoi(node: VoronoiParams): GraphResult {
  const { min, max } = node;
  const spacing = (1 / node.density) ** (1 / 3);
  const margin = 1.2 * spacing;
  const grown = [0, 1, 2].map((axis) => (max[axis] as number) - (min[axis] as number) + 2 * margin);
  const expected = Math.round(node.density * (grown[0] as number) * (grown[1] as number) * (grown[2] as number));
  if (expected > MAX_SEEDS)
    return {
      ok: false,
      code: 'IMP_GRAPH_TOO_LARGE',
      message: `density ${node.density} puts ${expected} seeds in the box (limit ${MAX_SEEDS}, about 9 beams each): lower the density or shrink the region`,
      ids: [],
    };
  const count = Math.max(expected, 8);
  const random = mulberry32(node.seed);
  const points: Vec3[] = [];
  for (let i = 0; i < count; i += 1)
    points.push([0, 1, 2].map((axis) => (min[axis] as number) - margin + random() * (grown[axis] as number)) as unknown as Vec3);
  const centre = [0, 1, 2].map((axis) => ((min[axis] as number) + (max[axis] as number)) / 2) as unknown as Vec3;
  const reach = 1000 * Math.max(...grown);
  for (const s of [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ] as const)
    points.push([centre[0] + s[0] * reach, centre[1] + s[1] * reach, centre[2] + s[2] * reach]);
  const { tets, skipped } = delaunay(points, count);
  // the two tetrahedra of every shared face, faces in the order they first occur (the order of the beams, which the content hash depends on)
  const slotOf = new Map<number, number>();
  const firstOwner: number[] = [];
  const secondOwner: number[] = [];
  tets.forEach(({ v }, index) => {
    for (const f of facesOf(v)) {
      const key = faceKey(f[0], f[1], f[2], points.length);
      const slot = slotOf.get(key);
      if (slot === undefined) {
        slotOf.set(key, firstOwner.length);
        firstOwner.push(index);
        secondOwner.push(-1);
      } else if (secondOwner[slot] === -1) secondOwner[slot] = index;
      else secondOwner[slot] = -2;
    }
  });
  const nodes: Vec3[] = [];
  const byKey = new Map<string, number>();
  const nodeAt = (p: Vec3): number => {
    const key = p.map((c) => Math.round(c * 1e9)).join(',');
    const known = byKey.get(key);
    if (known !== undefined) return known;
    nodes.push(p);
    byKey.set(key, nodes.length - 1);
    return nodes.length - 1;
  };
  const beams: StrutBeam[] = [];
  let dropped = skipped.length;
  let totalLength = 0;
  for (let slot = 0; slot < firstOwner.length; slot += 1) {
    if ((secondOwner[slot] as number) < 0) continue;
    const cut = clipSegment((tets[firstOwner[slot] as number] as Tet).c, (tets[secondOwner[slot] as number] as Tet).c, min, max);
    if (cut === null) continue;
    const [a, b] = [nodeAt(cut[0]), nodeAt(cut[1])];
    if (a === b) {
      dropped += 1;
      continue;
    }
    beams.push({ a, b, ra: node.radius, rb: node.radius, cap: node.cap });
    const [p, q] = [nodes[a] as Vec3, nodes[b] as Vec3];
    totalLength += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  }
  if (beams.length === 0)
    return { ok: false, code: 'IMP_GRAPH_EMPTY', message: 'the seeds produced no Voronoi edge inside the box', ids: [] };
  if (beams.length > MAX_VORONOI_BEAMS)
    return {
      ok: false,
      code: 'IMP_GRAPH_TOO_LARGE',
      message: `${beams.length} beams exceed the limit of ${MAX_VORONOI_BEAMS}: lower the density`,
      ids: [],
    };
  return { ok: true, graph: { set: { periodic: null, nodes, beams }, dropped, totalLength, radiusMax: node.radius } };
}
