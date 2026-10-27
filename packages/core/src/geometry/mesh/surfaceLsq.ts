/**
 * Least-squares B-spline patch through a mesh region (07 MSH FR-MSH-24): parameters from the orthogonal projection onto the best-fit plane,
 * then rounds of (weighted least squares on the pole grid with a second-difference fairing) and foot-point parameter correction (Hoschek).
 * Pure; deterministic.
 */

import type { MeshData, Vec3 } from '../../model/types';
import { conjugateGradient } from '../../lib/conjugateGradient';
import { clampedUniformKnots } from '../../lib/nurbs/knotVector';
import { basisFunctions, findSpan } from '../../lib/nurbs/basis';
import { refineOnSurface } from '../../lib/nurbs/closest';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { symmetricEigen } from '../../lib/symmetricEigen';
import { cross3, dot3, normalize3OrZero, sub3 } from '../../lib/vec3';

const CG_TOLERANCE = 1e-12;
const CG_MAX_ITERATIONS = 800;
/** A round must lower the maximum by this fraction, or the fit has stalled. */
const STALL_FRACTION = 0.01;
/** Triangles whose normal makes an angle with the plane normal above this (cosine at or below it) are folded or vertical in the projection. */
const FOLD_COSINE = 0.1;

interface PlaneFrame {
  readonly origin: Vec3;
  readonly uAxis: Vec3;
  readonly vAxis: Vec3;
  /** Normal on the side the region's triangle normals face. */
  readonly normal: Vec3;
}

export interface RegionFrame {
  readonly frame: PlaneFrame;
  /** Fraction of the region's area whose triangles are folded or vertical against the plane (the projection is not a parameterisation above a few percent). */
  readonly foldedFraction: number;
  readonly area: number;
}

/** Best-fit plane of the triangles `faces` (indices of triangles of `mesh`): area-weighted centroid, smallest principal axis, oriented with the mean triangle normal; null when degenerate. */
export function regionFrame(mesh: MeshData, faces: ReadonlyArray<number>): RegionFrame | null {
  const point = (v: number): Vec3 => [
    mesh.positions[3 * v] as number,
    mesh.positions[3 * v + 1] as number,
    mesh.positions[3 * v + 2] as number,
  ];
  let area = 0;
  let centre: Vec3 = [0, 0, 0];
  let meanNormal: Vec3 = [0, 0, 0];
  const triangles = faces.map((f) => {
    const [a, b, c] = [
      point(mesh.indices[3 * f] as number),
      point(mesh.indices[3 * f + 1] as number),
      point(mesh.indices[3 * f + 2] as number),
    ];
    const cross = cross3(sub3(b, a), sub3(c, a));
    const size = Math.hypot(...cross) / 2;
    const middle: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    return { cross, size, middle, corners: [a, b, c] as const };
  });
  for (const t of triangles) {
    area += t.size;
    centre = [centre[0] + t.size * t.middle[0], centre[1] + t.size * t.middle[1], centre[2] + t.size * t.middle[2]];
    meanNormal = [meanNormal[0] + t.cross[0] / 2, meanNormal[1] + t.cross[1] / 2, meanNormal[2] + t.cross[2] / 2];
  }
  if (!(area > 0)) return null;
  const origin: Vec3 = [centre[0] / area, centre[1] / area, centre[2] / area];
  // exact second moments of the surface (A / 12 * (sum d_i d_i^T + s s^T) per triangle), not of the triangle centres
  const m: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  for (const t of triangles) {
    const d = t.corners.map((corner) => sub3(corner, origin)) as [Vec3, Vec3, Vec3];
    const sum: Vec3 = [d[0][0] + d[1][0] + d[2][0], d[0][1] + d[1][1] + d[2][1], d[0][2] + d[1][2] + d[2][2]];
    const moment = (i: 0 | 1 | 2, j: 0 | 1 | 2): number =>
      (t.size / 12) * (d[0][i] * d[0][j] + d[1][i] * d[1][j] + d[2][i] * d[2][j] + sum[i] * sum[j]);
    m[0] = (m[0] as number) + moment(0, 0);
    m[1] = (m[1] as number) + moment(1, 1);
    m[2] = (m[2] as number) + moment(2, 2);
    m[3] = (m[3] as number) + moment(0, 1);
    m[4] = (m[4] as number) + moment(0, 2);
    m[5] = (m[5] as number) + moment(1, 2);
  }
  const axes = symmetricEigen(m);
  if (axes === null) return null;
  const mean = normalize3OrZero(meanNormal);
  const raw = axes.axes[0];
  const normal: Vec3 = dot3(raw, mean) >= 0 ? raw : [-raw[0], -raw[1], -raw[2]];
  const uAxis = normalize3OrZero(
    sub3(axes.axes[2], [
      normal[0] * dot3(axes.axes[2], normal),
      normal[1] * dot3(axes.axes[2], normal),
      normal[2] * dot3(axes.axes[2], normal),
    ]),
  );
  const vAxis = cross3(normal, uAxis);
  let folded = 0;
  for (const t of triangles) if (dot3(normalize3OrZero(t.cross), normal) <= FOLD_COSINE) folded += t.size;
  return { frame: { origin, uAxis, vAxis, normal }, foldedFraction: folded / area, area };
}

export interface PatchOptions {
  readonly degree: number;
  readonly countU: number;
  readonly countV: number;
  /** Weight of the second-difference fairing of the pole grid. */
  readonly smoothing: number;
  /** Most fit rounds. */
  readonly rounds: number;
  /** Stop as soon as the largest foot-point distance is within this (document units); omitted: run all rounds unless stalled. */
  readonly tolerance?: number | undefined;
}

export interface PatchStats {
  readonly max: number;
  readonly mean: number;
  readonly rms: number;
  readonly worst: Vec3;
}

export interface PatchFit {
  readonly surface: NurbsSurfaceData;
  readonly rounds: number;
  /** Foot-point distance of the samples to the final patch. */
  readonly stats: PatchStats;
  readonly stalled: boolean;
}

/** Sparse rows of the tensor basis at the parameters, and the number of poles. */
function basisRows(
  params: ReadonlyArray<readonly [number, number]>,
  options: PatchOptions,
  knots: { u: number[]; v: number[] },
): { start: Int32Array; col: Int32Array; value: Float64Array } {
  const { degree, countU, countV } = options;
  const width = (degree + 1) ** 2;
  const start = new Int32Array(params.length + 1);
  const col = new Int32Array(params.length * width);
  const value = new Float64Array(params.length * width);
  params.forEach(([u, v], k) => {
    const spanU = findSpan(countU, degree, u, knots.u);
    const spanV = findSpan(countV, degree, v, knots.v);
    const nu = basisFunctions(spanU, u, degree, knots.u);
    const nv = basisFunctions(spanV, v, degree, knots.v);
    let at = k * width;
    for (let a = 0; a <= degree; a++)
      for (let b = 0; b <= degree; b++) {
        col[at] = (spanU - degree + a) * countV + (spanV - degree + b);
        value[at] = (nu[a] as number) * (nv[b] as number);
        at++;
      }
    start[k + 1] = (k + 1) * width;
  });
  return { start, col, value };
}

interface Fairing {
  readonly c0: number;
  readonly c1: number;
  readonly c2: number;
  readonly weight: number;
}

/**
 * Second divided differences of the poles over their Greville abscissae (so poles that are linear in them, a plane in a linear parameterisation, cost
 * nothing), scaled to the plain second difference for equal spacing; one per consecutive triple of poles.
 */
function fairingOf(count: number, degree: number): Fairing[] {
  const knots = expandedKnots(count, degree);
  const greville = Array.from({ length: count }, (_, i) => {
    let total = 0;
    for (let k = 1; k <= degree; k++) total += knots[i + k] as number;
    return total / degree;
  });
  const mean = 1 / (count - 1);
  return Array.from({ length: Math.max(0, count - 2) }, (_, i) => {
    const h1 = (greville[i + 1] as number) - (greville[i] as number);
    const h2 = (greville[i + 2] as number) - (greville[i + 1] as number);
    return { c0: mean / h1, c1: -mean * (1 / h1 + 1 / h2), c2: mean / h2, weight: (h1 + h2) / (2 * mean) };
  });
}

/** Solves the weighted fairing-regularised normal equations for the pole grid (row-major i * countV + j); null when not finite. */
function solvePoles(
  rows: { start: Int32Array; col: Int32Array; value: Float64Array },
  points: ReadonlyArray<Vec3>,
  weights: ReadonlyArray<number>,
  options: PatchOptions,
  previous: Float64Array[] | null,
): Float64Array[] | null {
  const { countU, countV } = options;
  const n = countU * countV;
  const lambda = options.smoothing / n;
  const fairU = fairingOf(countU, options.degree);
  const fairV = fairingOf(countV, options.degree);
  const apply = (x: Float64Array, out: Float64Array): void => {
    out.fill(0);
    for (let k = 0; k < points.length; k++) {
      let s = 0;
      for (let q = rows.start[k] as number; q < (rows.start[k + 1] as number); q++)
        s += (rows.value[q] as number) * (x[rows.col[q] as number] as number);
      s *= weights[k] as number;
      for (let q = rows.start[k] as number; q < (rows.start[k + 1] as number); q++)
        out[rows.col[q] as number] = (out[rows.col[q] as number] as number) + (rows.value[q] as number) * s;
    }
    const second = (i0: number, j0: number, di: number, dj: number): void => {
      const f = (di === 1 ? fairU[i0] : fairV[j0]) as Fairing;
      const [a, b, c] = [i0 * countV + j0, (i0 + di) * countV + j0 + dj, (i0 + 2 * di) * countV + j0 + 2 * dj];
      const d = f.c0 * (x[a] as number) + f.c1 * (x[b] as number) + f.c2 * (x[c] as number);
      const scaled = lambda * f.weight * d;
      out[a] = (out[a] as number) + f.c0 * scaled;
      out[b] = (out[b] as number) + f.c1 * scaled;
      out[c] = (out[c] as number) + f.c2 * scaled;
    };
    for (let i = 0; i + 2 < countU; i++) for (let j = 0; j < countV; j++) second(i, j, 1, 0);
    for (let i = 0; i < countU; i++) for (let j = 0; j + 2 < countV; j++) second(i, j, 0, 1);
  };
  const diagonal = new Float64Array(n);
  for (let k = 0; k < points.length; k++)
    for (let q = rows.start[k] as number; q < (rows.start[k + 1] as number); q++)
      diagonal[rows.col[q] as number] =
        (diagonal[rows.col[q] as number] as number) + (weights[k] as number) * (rows.value[q] as number) ** 2;
  for (let c = 0; c < n; c++) diagonal[c] = (diagonal[c] as number) + 6 * lambda * 4;
  const solution: Float64Array[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const rhs = new Float64Array(n);
    for (let k = 0; k < points.length; k++) {
      const scaled = (weights[k] as number) * ((points[k] as Vec3)[axis] as number);
      for (let q = rows.start[k] as number; q < (rows.start[k + 1] as number); q++)
        rhs[rows.col[q] as number] = (rhs[rows.col[q] as number] as number) + (rows.value[q] as number) * scaled;
    }
    const result = conjugateGradient(apply, rhs, previous?.[axis] ?? new Float64Array(n), {
      maxIterations: CG_MAX_ITERATIONS,
      tolerance: CG_TOLERANCE,
      diagonal,
    });
    if (!result.x.every(Number.isFinite)) return null;
    solution.push(result.x);
  }
  return solution;
}

function surfaceOf(poles: Float64Array[], options: PatchOptions): NurbsSurfaceData {
  const { degree, countU, countV } = options;
  const u = clampedUniformKnots(countU, degree);
  const v = clampedUniformKnots(countV, degree);
  return {
    degreeU: degree,
    degreeV: degree,
    poles: Array.from({ length: countU }, (_, i) =>
      Array.from({ length: countV }, (_, j): Vec3 => {
        const c = i * countV + j;
        return [(poles[0] as Float64Array)[c] as number, (poles[1] as Float64Array)[c] as number, (poles[2] as Float64Array)[c] as number];
      }),
    ),
    knotsU: u.knots,
    multiplicitiesU: u.multiplicities,
    knotsV: v.knots,
    multiplicitiesV: v.multiplicities,
  };
}

/** Foot-point parameters and distances of `points` on `surface`, started from `params`. */
export function footPoints(
  surface: NurbsSurfaceData,
  points: ReadonlyArray<Vec3>,
  params: ReadonlyArray<readonly [number, number]>,
): { params: Array<[number, number]>; stats: PatchStats } {
  const next: Array<[number, number]> = [];
  let [max, sum, sumSq] = [0, 0, 0];
  let worst: Vec3 = points[0] ?? [0, 0, 0];
  points.forEach((point, k) => {
    const [u0, v0] = params[k] as readonly [number, number];
    const hit = refineOnSurface(surface, point, u0, v0);
    next.push([hit.u, hit.v]);
    sum += hit.distance;
    sumSq += hit.distance * hit.distance;
    if (hit.distance > max) [max, worst] = [hit.distance, point];
  });
  const n = Math.max(1, points.length);
  return { params: next, stats: { max, mean: sum / n, rms: Math.sqrt(sumSq / n), worst } };
}

/**
 * Fits a patch to `points` (weights sum to 1) whose first parameters are `params` (in [0, 1]).
 * @failure null when a solve is not finite
 */
export function fitPatch(
  points: ReadonlyArray<Vec3>,
  weights: ReadonlyArray<number>,
  params: ReadonlyArray<readonly [number, number]>,
  options: PatchOptions,
): PatchFit | null {
  const knots = { u: expandedKnots(options.countU, options.degree), v: expandedKnots(options.countV, options.degree) };
  let current: ReadonlyArray<readonly [number, number]> = params;
  let poles: Float64Array[] | null = null;
  let best: { surface: NurbsSurfaceData; stats: PatchStats } | null = null;
  let [rounds, stalled] = [0, false];
  for (;;) {
    const solved = solvePoles(basisRows(current, options, knots), points, weights, options, poles);
    if (solved === null) return null;
    poles = solved;
    rounds++;
    const surface = surfaceOf(poles, options);
    const feet = footPoints(surface, points, current);
    const previous = best?.stats.max ?? Infinity;
    if (feet.stats.max < previous) best = { surface, stats: feet.stats };
    current = feet.params;
    if (options.tolerance !== undefined && feet.stats.max <= options.tolerance) break;
    if (rounds >= options.rounds) break;
    if (rounds > 1 && feet.stats.max > previous * (1 - STALL_FRACTION)) {
      stalled = true;
      break;
    }
  }
  const chosen = best as { surface: NurbsSurfaceData; stats: PatchStats };
  return { surface: chosen.surface, rounds, stats: chosen.stats, stalled };
}

function expandedKnots(count: number, degree: number): number[] {
  const { knots, multiplicities } = clampedUniformKnots(count, degree);
  return knots.flatMap((k, i) => new Array<number>(multiplicities[i] as number).fill(k));
}
