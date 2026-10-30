/**
 * Voronoi (stochastic) beam lattice (05 IMP FR-IMP-19, M6): the edges of the Voronoi diagram of a seeded point set, clipped to a box. The points come from a
 * seeded mulberry32 generator in the box grown by 1.2 mean spacings (so cells at the box wall are complete), the diagram from a Bowyer-Watson Delaunay
 * tetrahedralisation (a Voronoi edge joins the circumcentres of two tetrahedra that share a face).
 * @invariant deterministic: the same (box, density, seed) gives the same beams on every machine (no Math.random, no clock, integer-seeded generator, fixed insertion order)
 * @invariant hull tetrahedra (those touching the enclosing tetrahedron) are dropped, so every kept edge has two interior ends; edges are cut to the box (Liang-Barsky)
 */

import type { StrutBeam } from '@core/geometry/field/program';
import type { Vec3 } from '@core/model/types';
import { type GraphResult, MAX_GRAPH_BEAMS } from './graph';
import type { VoronoiNode } from './model';

/** Seeds beyond this are refused: the Bowyer-Watson pass is quadratic (6000 seeds, 55000 beams: 9-12 s; 10000 seeds: 32-43 s), and a seed adds about 9 beams (measured), so 6000 seeds stay under the 100000 beams of a graph lattice. */
const MAX_SEEDS = 6000;

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

interface Tet {
  readonly v: readonly [number, number, number, number];
  readonly c: Vec3;
  readonly r2: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Circumsphere of four points, or null when they are coplanar. */
function circumsphere(a: Vec3, b: Vec3, c: Vec3, d: Vec3): { c: Vec3; r2: number } | null {
  const [u, v, w] = [sub(b, a), sub(c, a), sub(d, a)];
  const denominator = 2 * dot(u, cross(v, w));
  if (Math.abs(denominator) < 1e-300) return null;
  const [vw, wu, uv] = [cross(v, w), cross(w, u), cross(u, v)];
  const [lu, lv, lw] = [dot(u, u), dot(v, v), dot(w, w)];
  const offset: Vec3 = [
    (lu * vw[0] + lv * wu[0] + lw * uv[0]) / denominator,
    (lu * vw[1] + lv * wu[1] + lw * uv[1]) / denominator,
    (lu * vw[2] + lv * wu[2] + lw * uv[2]) / denominator,
  ];
  return { c: [a[0] + offset[0], a[1] + offset[1], a[2] + offset[2]], r2: dot(offset, offset) };
}

const faceKey = (a: number, b: number, c: number): string => [a, b, c].sort((x, y) => x - y).join(',');

const facesOf = ([a, b, c, d]: readonly [number, number, number, number]): ReadonlyArray<readonly [number, number, number]> => [
  [a, b, c],
  [a, b, d],
  [a, c, d],
  [b, c, d],
];

/** Delaunay tetrahedra of `points` (the last four points are the enclosing tetrahedron) that do not touch it. */
function delaunay(points: readonly Vec3[], real: number): Tet[] {
  let tets: Tet[] = [];
  const add = (a: number, b: number, c: number, d: number): void => {
    const sphere = circumsphere(points[a] as Vec3, points[b] as Vec3, points[c] as Vec3, points[d] as Vec3);
    if (sphere !== null) tets.push({ v: [a, b, c, d], ...sphere });
  };
  add(real, real + 1, real + 2, real + 3);
  for (let p = 0; p < real; p += 1) {
    const point = points[p] as Vec3;
    const bad: Tet[] = [];
    const rest: Tet[] = [];
    for (const tet of tets) {
      const d = sub(point, tet.c);
      (dot(d, d) < tet.r2 * (1 - 1e-12) ? bad : rest).push(tet);
    }
    const faces = new Map<string, readonly [number, number, number] | null>();
    for (const { v } of bad)
      for (const f of facesOf(v)) {
        const key = faceKey(f[0], f[1], f[2]);
        faces.set(key, faces.has(key) ? null : f);
      }
    tets = rest;
    for (const f of faces.values()) if (f !== null) add(f[0], f[1], f[2], p);
  }
  return tets.filter((tet) => tet.v.every((index) => index < real));
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

/** Beams of the Voronoi lattice of `node`. */
export function voronoiGeometry(node: Pick<VoronoiNode, 'min' | 'max' | 'density' | 'seed' | 'radius' | 'cap'>): GraphResult {
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
  const tets = delaunay(points, count);
  const owner = new Map<string, number[]>();
  tets.forEach(({ v }, index) => {
    for (const f of facesOf(v)) {
      const key = faceKey(f[0], f[1], f[2]);
      owner.set(key, [...(owner.get(key) ?? []), index]);
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
  let dropped = 0;
  let totalLength = 0;
  for (const pair of owner.values()) {
    if (pair.length !== 2) continue;
    const cut = clipSegment((tets[pair[0] as number] as Tet).c, (tets[pair[1] as number] as Tet).c, min, max);
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
  if (beams.length > MAX_GRAPH_BEAMS)
    return {
      ok: false,
      code: 'IMP_GRAPH_TOO_LARGE',
      message: `${beams.length} beams exceed the limit of ${MAX_GRAPH_BEAMS}: lower the density`,
      ids: [],
    };
  return { ok: true, graph: { set: { periodic: null, nodes, beams }, dropped, totalLength, radiusMax: node.radius } };
}
