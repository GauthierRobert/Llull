/**
 * Fit of a Catmull-Clark cage to a target triangle mesh (07 MSH FR-MSH-23): the limit surface is linear in the cage positions
 * (`subd/fitOperator`), so each round is one sparse least-squares solve against closest points, repeated with fresh closest points
 * (forward: limit samples to the target; backward: target samples to the limit surface, as barycentric rows over the limit triangles).
 * Pure; deterministic.
 */

import type { MeshData, Vec3 } from '../../model/types';
import { buildTopology, neighbourVertices } from '../subd/topology';
import { type Cage } from '../subdivision';
import { type FitOperator, applyOperator, buildFitOperator, limitSurfaceMesh, limitTriangles, sampleLevel } from '../subd/fitOperator';
import { symmetricDeviation } from './deviation';
import { SurfaceIndex } from './surfaceIndex';
import { VertexGrid } from './vertexGrid';
import { type CgReport, type RoundRows, NO_CG, solvePins, solveRound } from './subdFitSystem';

/** Most target vertices used as backward samples. */
const MAX_BACKWARD_SAMPLES = 20_000;
/** Most samples of the final verification, per mesh. */
const VERIFY_MAX_SAMPLES = 200_000;
/** Largest quad count of the verification mesh (it is built on points, not as a matrix). */
const VERIFY_MAX_QUADS = 400_000;
/** Most limit triangles whose normal is compared with the target normal. */
const FOLD_MAX_CHECKS = 50_000;
/** A limit triangle whose normal makes an angle of more than this (cosine below it) with the target normal at its closest point counts as folded. */
const FOLD_COSINE = -0.2;
/** A round must lower the maximum by this fraction of the best so far, or the fit has stalled. */
const STALL_FRACTION = 0.01;
/**
 * Triangle tests one closest-point query may cost on average before the placement of the cage counts as a work problem: a query into a healthy tree
 * tests a few dozen triangles (measured 40 to 120), one into a tree whose boxes are all equally far tests them all.
 */
export const WORK_PER_QUERY = 600;

export interface SubdFitOptions {
  /** Subdivision level of the samples (raised to what the semi-sharp creases of the cage need). */
  readonly level: number;
  readonly maxDeviation: number;
  /** Most solve rounds after the initial measurement. */
  readonly iterations: number;
  /** Pin the limit points of the cage vertices to the nearest target vertices (exact) instead of minimising the distance to the whole surface. */
  readonly interpolate: boolean;
  /** Weight of the fairing term on the cage displacement (mean squared umbrella Laplacian of the displacement per cage vertex). */
  readonly smoothing: number;
  /** The target is a closed, outward-wound mesh: folds of the limit surface are looked for. */
  readonly targetClosed: boolean;
}

interface FitStats {
  readonly max: number;
  readonly mean: number;
  readonly rms: number;
  /** Limit samples to the target / target samples to the limit surface. */
  readonly forwardMax: number;
  readonly backwardMax: number;
}

/** Why the rounds ended: `met` (verified within maxDeviation), `met_on_samples` (within it on the fit samples, not on the verification mesh), `stalled`, `rounds`, `budget` (closest-point work cap), `pinned` (interpolation is one exact solve). */
export type FitStop = 'met' | 'met_on_samples' | 'stalled' | 'rounds' | 'budget' | 'pinned';

export interface SubdFitResult {
  readonly vertices: Vec3[];
  /** Solve rounds run. */
  readonly rounds: number;
  readonly converged: boolean;
  readonly stop: FitStop;
  /** Measured on the level-`fitLevel` limit samples before any round. */
  readonly initial: FitStats;
  /** Measured on the level-`verifyLevel` limit mesh of the returned cage, both directions (vertices, edge midpoints, triangle centres). */
  readonly final: FitStats & { readonly worst: Vec3; readonly samples: number };
  readonly fitLevel: number;
  readonly verifyLevel: number;
  readonly rows: number;
  readonly cg: CgReport;
  /** Limit triangles whose normal opposes the target normal at their closest point / triangles compared (0 compared: target not closed). */
  readonly folded: { readonly count: number; readonly checked: number };
  /** Interpolation: the largest distance between a pinned limit point and its target vertex. */
  readonly pinResidual: number | null;
  /** Interpolation: cage vertices pinned to a target vertex that another cage vertex is pinned to as well (a coarse target makes the surface collapse there). */
  readonly sharedPins: number | null;
}

export interface SubdFitFailure {
  readonly code: 'MESH_FIT_FAILED' | 'MESH_FIT_CAGE_FAR';
  readonly message: string;
}

const coordinate = (points: ReadonlyArray<Vec3>, axis: number): Float64Array => Float64Array.from(points, (p) => p[axis] as number);

/** Backward samples: target vertices (strided down to the cap). */
function backwardSamples(target: MeshData): Vec3[] {
  const used = new Set<number>(target.indices);
  const all = [...used].sort((a, b) => a - b);
  const stride = Math.max(1, Math.ceil(all.length / MAX_BACKWARD_SAMPLES));
  const picked: Vec3[] = [];
  for (let i = 0; i < all.length; i += stride) {
    const v = all[i] as number;
    picked.push([target.positions[3 * v] as number, target.positions[3 * v + 1] as number, target.positions[3 * v + 2] as number]);
  }
  return picked;
}

interface Measured extends RoundRows {
  readonly stats: FitStats;
}

interface OverBudget {
  readonly overBudget: true;
  /** Root mean square distance of the forward queries answered before the budget ran out. */
  readonly forwardRms: number;
  readonly answered: number;
}

function measure(
  op: FitOperator,
  positions: Float64Array[],
  targetIndex: SurfaceIndex,
  samples: ReadonlyArray<Vec3>,
): Measured | OverBudget {
  const rows = op.rows;
  const queries = rows + samples.length;
  const budget = WORK_PER_QUERY * queries;
  const flat: number[] = new Array<number>(rows * 3);
  for (let r = 0; r < rows; r++) for (let a = 0; a < 3; a++) flat[3 * r + a] = (positions[a] as Float64Array)[r] as number;
  const closest: Vec3[] = new Array<Vec3>(rows);
  let [forwardMax, sum, sumSq, forwardSumSq] = [0, 0, 0, 0];
  const testsBefore = targetIndex.tests;
  for (let r = 0; r < rows; r++) {
    const hit = targetIndex.closest([flat[3 * r] as number, flat[3 * r + 1] as number, flat[3 * r + 2] as number]);
    closest[r] = hit.point;
    forwardMax = Math.max(forwardMax, hit.distance);
    sum += hit.distance;
    sumSq += hit.distance * hit.distance;
    forwardSumSq = sumSq;
    if (targetIndex.tests - testsBefore > budget)
      return { overBudget: true, forwardRms: Math.sqrt(forwardSumSq / (r + 1)), answered: r + 1 };
  }
  const mesh = limitTriangles(op, flat);
  const limitIndex = new SurfaceIndex(mesh.positions, mesh.indices);
  const rowsOf = new Int32Array(samples.length * 3);
  const weightOf = new Float64Array(samples.length * 3);
  let backwardMax = 0;
  for (let j = 0; j < samples.length; j++) {
    const hit = limitIndex.closest(samples[j] as Vec3);
    // one counter for the whole round: the backward half spends what the forward half left
    if (targetIndex.tests - testsBefore + limitIndex.tests > budget)
      return { overBudget: true, forwardRms: Math.sqrt(forwardSumSq / rows), answered: rows };
    backwardMax = Math.max(backwardMax, hit.distance);
    sum += hit.distance;
    sumSq += hit.distance * hit.distance;
    const bary = limitIndex.barycentric(hit.face, hit.point);
    for (let k = 0; k < 3; k++) {
      rowsOf[3 * j + k] = mesh.indices[3 * hit.face + k] as number;
      weightOf[3 * j + k] = bary[k] as number;
    }
  }
  return {
    stats: { max: Math.max(forwardMax, backwardMax), mean: sum / queries, rms: Math.sqrt(sumSq / queries), forwardMax, backwardMax },
    closest,
    rowsOf,
    weightOf,
  };
}

function neighbours(cage: Cage): number[][] {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  return cage.vertices.map((_, v) => neighbourVertices(topology, v));
}

/** Cage and target must be of the same size and place: a collapsed or distant cage gives limit samples that are all alike and equally far, which defeats the closest-point tree. */
const MAX_SIZE_RATIO = 10;

function boxOf(flat: ReadonlyArray<number>): { centre: Vec3; diagonal: number } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < flat.length; i++) {
    const axis = i % 3;
    lo[axis] = Math.min(lo[axis] as number, flat[i] as number);
    hi[axis] = Math.max(hi[axis] as number, flat[i] as number);
  }
  const centre: Vec3 = [
    ((lo[0] as number) + (hi[0] as number)) / 2,
    ((lo[1] as number) + (hi[1] as number)) / 2,
    ((lo[2] as number) + (hi[2] as number)) / 2,
  ];
  return {
    centre,
    diagonal: Math.hypot(
      (hi[0] as number) - (lo[0] as number),
      (hi[1] as number) - (lo[1] as number),
      (hi[2] as number) - (lo[2] as number),
    ),
  };
}

/** Why the cage is not in the place of the target (null when it is): box diagonals within a factor of 10 and centres within one target diagonal. */
function farFromTarget(vertices: ReadonlyArray<Vec3>, targetPositions: ReadonlyArray<number>): string | null {
  const [cage, target] = [boxOf(vertices.flat()), boxOf(targetPositions)];
  const apart = Math.hypot(cage.centre[0] - target.centre[0], cage.centre[1] - target.centre[1], cage.centre[2] - target.centre[2]);
  if (!(cage.diagonal * MAX_SIZE_RATIO >= target.diagonal && cage.diagonal <= target.diagonal * MAX_SIZE_RATIO))
    return `the cage box diagonal (${cage.diagonal.toPrecision(4)}) and the target's (${target.diagonal.toPrecision(4)}) differ by more than a factor ${MAX_SIZE_RATIO}`;
  if (!(apart <= target.diagonal))
    return `the cage centre is ${apart.toPrecision(4)} from the target centre (more than the target box diagonal ${target.diagonal.toPrecision(4)})`;
  return null;
}

/**
 * Nearest target vertex of each of the first `count` limit rows (the true nearest vertex of the target, not a corner of the closest triangle), and how
 * many cage vertices were given a vertex that an earlier cage vertex already has.
 */
function nearestVertices(grid: VertexGrid, target: MeshData, limit: Float64Array[], count: number): { pins: Vec3[]; shared: number } {
  const picked: Vec3[] = [];
  const taken = new Set<number>();
  let shared = 0;
  for (let r = 0; r < count; r++) {
    const { index } = grid.nearest([
      (limit[0] as Float64Array)[r] as number,
      (limit[1] as Float64Array)[r] as number,
      (limit[2] as Float64Array)[r] as number,
    ]);
    if (taken.has(index)) shared++;
    taken.add(index);
    picked.push([
      target.positions[3 * index] as number,
      target.positions[3 * index + 1] as number,
      target.positions[3 * index + 2] as number,
    ]);
  }
  return { pins: picked, shared };
}

/** Limit triangles (strided to a cap) whose normal opposes the normal of the closest target triangle: the surface is inside out or folded there. */
function foldedTriangles(limit: MeshData, target: MeshData, targetIndex: SurfaceIndex): { count: number; checked: number } {
  const total = limit.indices.length / 3;
  const stride = Math.max(1, Math.ceil(total / FOLD_MAX_CHECKS));
  const point = (mesh: MeshData, v: number): Vec3 => [
    mesh.positions[3 * v] as number,
    mesh.positions[3 * v + 1] as number,
    mesh.positions[3 * v + 2] as number,
  ];
  const normalOf = (mesh: MeshData, f: number): Vec3 => {
    const [a, b, c] = [
      point(mesh, mesh.indices[3 * f] as number),
      point(mesh, mesh.indices[3 * f + 1] as number),
      point(mesh, mesh.indices[3 * f + 2] as number),
    ];
    const [u, v] = [
      [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    ] as [Vec3, Vec3];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n);
    return length > 0 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 0, 0];
  };
  let [count, checked] = [0, 0];
  for (let f = 0; f < total; f += stride) {
    const [a, b, c] = [
      point(limit, limit.indices[3 * f] as number),
      point(limit, limit.indices[3 * f + 1] as number),
      point(limit, limit.indices[3 * f + 2] as number),
    ];
    const hit = targetIndex.closest([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
    if (hit.face < 0) continue;
    const [n, m] = [normalOf(limit, f), normalOf(target, hit.face)];
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    checked++;
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < FOLD_COSINE) count++;
  }
  return { count, checked };
}

/**
 * Moves the cage vertices so that the limit surface of `cage` follows `target` (cage and target in one frame).
 * @invariant topology, creases and sharpness are untouched; the returned cage is the best of the initial one and every round (never worse than the input on the fit samples); the closest-point work of a round is capped
 * @failure non-finite solution -> MESH_FIT_FAILED; the cage is far from the target or its first measurement exceeds the work cap -> MESH_FIT_CAGE_FAR
 */
export function fitSubdivision(cage: Cage, target: MeshData, options: SubdFitOptions): SubdFitResult | SubdFitFailure {
  const far = farFromTarget(cage.vertices, target.positions);
  if (far !== null) return { code: 'MESH_FIT_CAGE_FAR', message: far };
  const level = sampleLevel(cage, options.level);
  const op = buildFitOperator(cage, level);
  const adjacent = neighbours(cage);
  const targetIndex = new SurfaceIndex(target.positions, target.indices);
  const samples = backwardSamples(target);
  const start = [0, 1, 2].map((a) => coordinate(cage.vertices, a));
  let current = start;
  let best = start;
  let bestStats: FitStats | null = null;
  let initial: FitStats | null = null;
  let [rounds, cg, pinResidual] = [0, NO_CG as CgReport, null as number | null];
  let sharedPins: number | null = null;
  let stop: FitStop = 'rounds';
  const positionsOf = (cageValues: Float64Array[]): Float64Array[] =>
    cageValues.map((values) => {
      const out = new Float64Array(op.rows);
      applyOperator(op, values, out);
      return out;
    });
  for (;;) {
    const limit = positionsOf(current);
    const round = measure(op, limit, targetIndex, samples);
    if ('overBudget' in round) {
      if (bestStats === null)
        return {
          code: 'MESH_FIT_CAGE_FAR',
          message: `the first closest-point round exceeded its work cap (${WORK_PER_QUERY} triangle tests per query) after ${round.answered} of ${op.rows} limit samples; their rms distance to the target is ${round.forwardRms.toPrecision(4)}, so the cage is badly placed`,
        };
      stop = 'budget';
      break;
    }
    initial ??= round.stats;
    const previousBest: number = bestStats?.max ?? Infinity;
    if (round.stats.max < previousBest) [best, bestStats] = [current, round.stats];
    if (options.interpolate && rounds === 0) {
      const grid = new VertexGrid(target.positions, target.indices);
      const nearest = nearestVertices(grid, target, limit, op.cols);
      sharedPins = nearest.shared;
      const pinned = solvePins(op, current, nearest.pins);
      if (!pinned.ok) return { code: 'MESH_FIT_FAILED', message: 'the pin solve produced non-finite cage positions' };
      [best, current, cg, pinResidual, rounds, stop] = [pinned.cage, pinned.cage, pinned.cg, pinned.residual, 1, 'pinned'];
      break;
    }
    if (round.stats.max <= options.maxDeviation) {
      stop = 'met';
      break;
    }
    if (rounds >= options.iterations) break;
    if (rounds > 0 && round.stats.max > previousBest * (1 - STALL_FRACTION)) {
      stop = 'stalled';
      break;
    }
    const solved = solveRound(op, adjacent, current, start, round, samples, options.smoothing);
    if (!solved.ok) return { code: 'MESH_FIT_FAILED', message: 'the least-squares solve produced non-finite cage positions' };
    cg = {
      iterations: cg.iterations + solved.cg.iterations,
      converged: cg.converged && solved.cg.converged,
      relativeResidual: Math.max(cg.relativeResidual, solved.cg.relativeResidual),
    };
    current = solved.cage;
    rounds++;
  }
  const vertices: Vec3[] = cage.vertices.map((_, v) => [
    (best[0] as Float64Array)[v] as number,
    (best[1] as Float64Array)[v] as number,
    (best[2] as Float64Array)[v] as number,
  ]);
  const fitted: Cage = { ...cage, vertices };
  let verifyLevel = level + 1;
  while (verifyLevel > level && cage.faces.length * 4 ** verifyLevel > VERIFY_MAX_QUADS) verifyLevel--;
  const { mesh: verify, level: verified } = limitSurfaceMesh(fitted, verifyLevel);
  const deviation = symmetricDeviation(verify, target, VERIFY_MAX_SAMPLES, { edgeMidpoints: true });
  if (deviation === null) return { code: 'MESH_FIT_FAILED', message: 'the limit surface or the target has no triangle to measure' };
  const converged = deviation.hausdorff <= options.maxDeviation;
  if (stop === 'met' && !converged) stop = 'met_on_samples';
  return {
    vertices,
    rounds,
    converged,
    stop,
    initial: initial as FitStats,
    final: {
      max: deviation.hausdorff,
      mean: deviation.mean,
      rms: deviation.rms,
      forwardMax: deviation.forwardMax,
      backwardMax: deviation.backwardMax,
      worst: deviation.worst.point,
      samples: deviation.samples,
    },
    fitLevel: level,
    verifyLevel: verified,
    rows: op.rows,
    cg,
    folded: options.targetClosed ? foldedTriangles(verify, target, targetIndex) : { count: 0, checked: 0 },
    pinResidual,
    sharedPins,
  };
}
