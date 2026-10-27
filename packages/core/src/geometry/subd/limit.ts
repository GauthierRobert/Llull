/**
 * Limit evaluation of a Catmull-Clark cage (04 DIR §5.2): limit point and normal at cage vertices (stencil masks), and surface points with
 * derivatives at (face, u, v) (uniform bicubic B-spline of the 4 x 4 ring of a regular quad, after local refinement). Pure.
 */

import type { Vec3 } from '../../model/types';
import { add3, cross3, dot3, len3, normalize3OrZero, scale3 } from '../../lib/vec3';
import { type Cage, type RefinableCage, subdivide } from '../subdivision';
import { dartMask } from './dartMask';
import { edgeKey } from './edgeKey';
import { settleLevels } from './settle';
import { levelQuadCount } from './volume';
import { SHARP_MAX, edgeSharpnessMap, vertexRule, vertexSharpnessArray, type VertexRule } from './sharpness';
import { type CageTopology, buildTopology, neighbourVertices, newellVector } from './topology';

/** A cage level prepared for evaluation. */
export interface Level {
  readonly cage: Cage;
  readonly topology: CageTopology;
  readonly sharp: Map<string, number>;
  readonly corners: number[];
}

/** Adjacency and effective sharpness of a refined level (boundary edges infinitely sharp, single-face boundary vertices corners unless `edge_only`). */
export function prepareSharpness(cage: RefinableCage<unknown>): Omit<Level, 'cage'> {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  const sharp = edgeSharpnessMap(cage);
  const corners = vertexSharpnessArray(cage, cage.vertices.length);
  // boundary edges are infinitely sharp; edge_and_corner pins the boundary vertices of a single face
  for (const edge of topology.edges) if (edge.faces.length === 1) sharp.set(edgeKey(edge.a, edge.b), SHARP_MAX);
  if (cage.boundary !== 'edge_only')
    topology.vertexFaces.forEach((around, v) => around.length === 1 && topology.vertexEdges[v]?.length === 2 && (corners[v] = SHARP_MAX));
  return { topology, sharp, corners };
}

export function prepare(cage: Cage): Level {
  return { cage, ...prepareSharpness(cage) };
}

/** Subdominant eigenvalue of the Catmull-Clark subdivision matrix for valence n. */
export function subdominantEigenvalue(n: number): number {
  const c = Math.cos((2 * Math.PI) / n);
  return 5 / 16 + (c + Math.cos(Math.PI / n) * Math.sqrt(2 * (9 + c))) / 16;
}

export interface VertexLimit {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly rule: VertexRule;
  readonly valence: number;
}

/** Neighbours across sharp edges (sharpness > 0) of v, and the rule they imply. */
function ruleAt(level: Level, v: number): { rule: VertexRule; sharpNeighbours: number[] } {
  const sharpNeighbours = neighbourVertices(level.topology, v).filter((w) => (level.sharp.get(edgeKey(v, w)) ?? 0) > 0);
  return { rule: vertexRule(sharpNeighbours.length, level.corners[v] as number), sharpNeighbours };
}

/** Fan of an interior vertex of an all-quad closed level: edge neighbours e_i and the opposite vertices d_i of the quad whose next vertex is e_i. */
export function fanOf(level: Pick<Level, 'topology'>, v: number): { e: number[]; d: number[] } {
  const { faces, directed, vertexFaces } = level.topology;
  const start = (vertexFaces[v] as number[])[0] as number;
  const e: number[] = [];
  const d: number[] = [];
  let f = start;
  do {
    const face = faces[f] as ReadonlyArray<number>;
    const i = face.indexOf(v);
    const next = face[(i + 1) % 4] as number;
    e.push(next);
    d.push(face[(i + 2) % 4] as number);
    f = directed.get(`${next}>${v}`) as number;
  } while (f !== start && e.length <= (vertexFaces[v] as number[]).length);
  return { e, d };
}

/** Limit point and unit normal of vertex `v` of an all-quad level (smooth: Halstead masks; crease: (4v+a+b)/6; corner: v). */
function vertexLimitOf(level: Level, v: number): VertexLimit {
  const p = (w: number): Vec3 => level.cage.vertices[w] as Vec3;
  const { rule, sharpNeighbours } = ruleAt(level, v);
  const valence = (level.topology.vertexEdges[v] as number[]).length;
  const faceNormal = (): Vec3 => {
    const around = (level.topology.vertexFaces[v] as number[]).map((f) =>
      newellVector(level.cage.vertices, level.cage.faces[f] as ReadonlyArray<number>),
    );
    return normalize3OrZero(around.reduce<Vec3>((sum, vector) => add3(sum, vector), [0, 0, 0]));
  };
  if (rule === 'corner') return { point: p(v), normal: faceNormal(), rule, valence };
  if (rule === 'crease') {
    const [a, b] = sharpNeighbours as [number, number];
    return { point: scale3(add3(add3(scale3(p(v), 4), p(a)), p(b)), 1 / 6), normal: faceNormal(), rule, valence };
  }
  const fan = fanOf(level, v);
  const n = fan.e.length;
  const sumE = fan.e.reduce<Vec3>((total, w) => add3(total, p(w)), [0, 0, 0]);
  const sumD = fan.d.reduce<Vec3>((total, w) => add3(total, p(w)), [0, 0, 0]);
  const sharpIndex = sharpNeighbours.length === 1 ? fan.e.indexOf(sharpNeighbours[0] as number) : -1;
  const dart = sharpIndex >= 0 ? dartMask(n, sharpIndex) : null;
  const point =
    dart === null
      ? scale3(add3(add3(scale3(p(v), n * n), scale3(sumE, 4)), sumD), 1 / (n * (n + 5)))
      : [...fan.e, ...fan.d].reduce<Vec3>(
          (total, w, k) => add3(total, scale3(p(w), dart[1 + k] as number)),
          scale3(p(v), dart[0] as number),
        );
  const theta = (2 * Math.PI) / n;
  const k = 1 / (4 * subdominantEigenvalue(n) - 1);
  const tangent = (shift: number): Vec3 => {
    let total: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const c0 = Math.cos((i + shift) * theta);
      const c1 = Math.cos((i + shift + 1) * theta);
      total = add3(total, scale3(p(fan.e[i] as number), 4 * c0));
      total = add3(total, scale3(p(fan.d[(i + 1) % n] as number), (c0 + c1) * k));
    }
    return total;
  };
  return { point, normal: normalize3OrZero(cross3(tangent(0), tangent(1))), rule, valence };
}

/** Limit points and normals of the cage vertices `vertices` (the cage is refined once when it has non-quad faces, and until its semi-sharp creases have decayed). */
export function cageVertexLimits(cage: Cage, vertices: readonly number[]): VertexLimit[] {
  const original = prepare(cage);
  const steps = Math.max(settleLevels(cage), cage.faces.every((face) => face.length === 4) ? 0 : 1);
  const level = steps === 0 ? original : prepare(subdivide(cage, steps));
  return vertices.map((v) => ({
    ...vertexLimitOf(level, v),
    rule: ruleAt(original, v).rule,
    valence: (original.topology.vertexEdges[v] as number[]).length,
  }));
}

type Weights = [number, number, number, number];
const BASIS = (t: number): Weights => [
  (1 - t) ** 3 / 6,
  (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
  (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
  t ** 3 / 6,
];
const BASIS_D1 = (t: number): Weights => [-((1 - t) ** 2) / 2, (3 * t ** 2 - 4 * t) / 2, (-3 * t ** 2 + 2 * t + 1) / 2, t ** 2 / 2];
const BASIS_D2 = (t: number): Weights => [1 - t, 3 * t - 2, -3 * t + 1, t];

export interface SurfaceSample {
  readonly point: Vec3;
  readonly du: Vec3;
  readonly dv: Vec3;
  readonly duu: Vec3;
  readonly duv: Vec3;
  readonly dvv: Vec3;
  /** Refinement depth at which the sample became a regular patch. */
  readonly depth: number;
  /** The patch was still irregular at the depth cap: the value is the limit point of the nearest corner, without derivatives. */
  readonly approximate: boolean;
}

/** The 4 x 4 vertex ring of quad `f` started at its corner `rotation` (rows along the first edge, columns along the last) when its four corners are regular, interior and smooth. */
export function regularRing(level: Level, f: number, rotation = 0): number[][] | null {
  const { topology, sharp, corners } = level;
  const raw = topology.faces[f] as ReadonlyArray<number>;
  const quad = raw.map((_, i) => raw[(i + rotation) % raw.length] as number);
  for (const v of quad) {
    const fan = topology.vertexFaces[v] as number[];
    if (fan.length !== 4 || (corners[v] as number) > 0 || fan.some((g) => (topology.faces[g] as ReadonlyArray<number>).length !== 4))
      return null;
    if (neighbourVertices(topology, v).some((w) => (sharp.get(edgeKey(v, w)) ?? 0) > 0)) return null;
  }
  const [a, b, c, d] = quad as [number, number, number, number];
  const after = (face: ReadonlyArray<number>, v: number, steps: number): number => face[(face.indexOf(v) + steps) % face.length] as number;
  const faceWith = (key: string): ReadonlyArray<number> => topology.faces[topology.directed.get(key) as number] as ReadonlyArray<number>;
  const [ab, bc, cd, da] = [faceWith(`${b}>${a}`), faceWith(`${c}>${b}`), faceWith(`${d}>${c}`), faceWith(`${a}>${d}`)];
  const [pa, qb, pb, qc] = [after(ab, a, 1), after(ab, b, 3), after(bc, b, 1), after(bc, c, 3)];
  const [pc, qd, pd, qa] = [after(cd, c, 1), after(cd, d, 3), after(da, d, 1), after(da, a, 3)];
  const diagonal = (key: string, v: number): number => after(faceWith(key), v, 2);
  const [c00, c30, c33, c03] = [diagonal(`${pa}>${a}`, a), diagonal(`${b}>${qb}`, b), diagonal(`${c}>${qc}`, c), diagonal(`${d}>${qd}`, d)];
  return [
    [c00, qa, pd, c03],
    [pa, a, d, qd],
    [qb, b, c, pc],
    [c30, pb, qc, c33],
  ];
}

/** The 4 x 4 control grid of quad `f` (x along its first edge, y along its last) when its four corners are regular, interior and smooth. */
function regularGrid(level: Level, f: number): Vec3[][] | null {
  const ring = regularRing(level, f);
  return ring === null ? null : ring.map((row) => row.map((w) => level.cage.vertices[w] as Vec3));
}

function evaluateGrid(grid: Vec3[][], x: number, y: number): Omit<SurfaceSample, 'depth' | 'approximate'> {
  const combine = (wx: Weights, wy: Weights): Vec3 => {
    let total: Vec3 = [0, 0, 0];
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) total = add3(total, scale3(grid[i]?.[j] as Vec3, (wx[i] as number) * (wy[j] as number)));
    return total;
  };
  return {
    point: combine(BASIS(x), BASIS(y)),
    du: combine(BASIS_D1(x), BASIS(y)),
    dv: combine(BASIS(x), BASIS_D1(y)),
    duu: combine(BASIS_D2(x), BASIS(y)),
    duv: combine(BASIS_D1(x), BASIS_D1(y)),
    dvv: combine(BASIS(x), BASIS_D2(y)),
  };
}

/** Quadrant child of a quad (the sub-quad at corner `child`) and the sample's coordinates inside it. */
function descend(u: number, v: number): { child: number; x: number; y: number } {
  if (u < 0.5) return v < 0.5 ? { child: 0, x: 2 * u, y: 2 * v } : { child: 3, x: 2 * (1 - v), y: 2 * u };
  return v < 0.5 ? { child: 1, x: 2 * v, y: 2 * (1 - u) } : { child: 2, x: 2 * (1 - u), y: 2 * (1 - v) };
}

/** Quads a refined level may have before a sample stops refining (a sample next to an extraordinary vertex would otherwise refine the whole cage). */
const EVALUATION_QUAD_BUDGET = 150_000;

/** Evaluator of (face, u, v) samples on one cage; refined levels are built lazily and shared. Null: the face is not a quad. */
export function surfaceEvaluator(
  cage: Cage,
  maxDepth = Math.max(4, settleLevels(cage) + 2),
): (face: number, u: number, v: number) => SurfaceSample | null {
  const levels: Level[] = [prepare(cage)];
  const firstChild: number[] = [0];
  for (const [i, face] of cage.faces.entries()) firstChild.push((firstChild[i] as number) + face.length);
  const levelAt = (depth: number): Level => {
    while (levels.length <= depth) levels.push(prepare(subdivide((levels[levels.length - 1] as Level).cage, 1)));
    return levels[depth] as Level;
  };
  return (face, u, v) => {
    let [f, x, y] = [face, u, v];
    let depth = 0;
    for (; ; depth++) {
      const level = levelAt(depth);
      if ((level.topology.faces[f] as ReadonlyArray<number> | undefined)?.length !== 4) return null;
      const grid = regularGrid(level, f);
      if (grid !== null) return { ...evaluateGrid(grid, x, y), depth, approximate: false };
      if (depth === maxDepth || levelQuadCount(cage, depth + 1) > EVALUATION_QUAD_BUDGET) break;
      const step = descend(x, y);
      [f, x, y] = [(depth === 0 ? (firstChild[f] as number) : 4 * f) + step.child, step.x, step.y];
    }
    const quad = levelAt(depth).topology.faces[f] as ReadonlyArray<number>;
    const limit = vertexLimitOf(levelAt(depth), quad[x < 0.5 ? (y < 0.5 ? 0 : 3) : y < 0.5 ? 1 : 2] as number);
    const zero: Vec3 = [0, 0, 0];
    return { point: limit.point, du: zero, dv: zero, duu: zero, duv: zero, dvv: zero, depth, approximate: true };
  };
}
/** Unit normal and principal curvatures (positive when convex) of a sample; null when the parametrisation is degenerate or approximate. */
export function sampleCurvature(sample: SurfaceSample): { normal: Vec3; k1: number; k2: number } | null {
  const cross = cross3(sample.du, sample.dv);
  const area = len3(cross);
  const e = dot3(sample.du, sample.du);
  const f = dot3(sample.du, sample.dv);
  const g = dot3(sample.dv, sample.dv);
  const determinant = e * g - f * f;
  if (sample.approximate || area < 1e-12 || determinant < 1e-18) return null;
  const normal = scale3(cross, 1 / area);
  const [l, m, n] = [dot3(sample.duu, normal), dot3(sample.duv, normal), dot3(sample.dvv, normal)];
  const gauss = (l * n - m * m) / determinant;
  const mean = (e * n + g * l - 2 * f * m) / (2 * determinant);
  const root = Math.sqrt(Math.max(0, mean * mean - gauss));
  return { normal, k1: root - mean, k2: -root - mean };
}
