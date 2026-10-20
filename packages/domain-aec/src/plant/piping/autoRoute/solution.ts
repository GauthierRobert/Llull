/**
 * Auto-route solutions (02 RTE §2.A): what a search returns and the check `auto_route_pipe` applies before it commits one. A solution
 * from any source (TypeScript reference, native `llull-route`, hand-written) is held to the same rule: fresh problem hash, axis-aligned
 * legs on the lattice with the port stubs, every leg clear of every inflated obstacle and keep-out, and the reported length / bends /
 * cost equal to the ones recomputed from its PIs.
 */

import type { Vec3 } from '@core/model/vectors';
import { AXIS_VECTORS, cellPointUm, firstBlocking, moveCost, type Int3, type RouteProblem } from './lattice';
import type { SearchResult } from './search';

export interface RouteSolution {
  readonly problemHash: string;
  /** Interior points of intersection, document units (mm). */
  readonly pis: readonly Vec3[];
  /** Centreline-to-PI length from port to port, stubs included (mm). */
  readonly lengthMm: number;
  readonly bends: number;
  /** Integer µm (lattice length + bends x bend cost + elevation penalties). */
  readonly cost: number;
  readonly optimal: boolean;
  readonly expansions: number;
  readonly engine: string;
}

export type SolutionCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly path: string };

const um = (mm: number): number => Math.round(mm * 1000);
const toMm = (p: Int3): Vec3 => [p[0] / 1000, p[1] / 1000, p[2] / 1000];
const along = (p: Int3, axis: number, length: number): Int3 => {
  const v = AXIS_VECTORS[axis] as Int3;
  return [p[0] + v[0] * length, p[1] + v[1] * length, p[2] + v[2] * length];
};

/** World polyline (µm) of a lattice route: from port, ...bend points, to port. */
function polylineUm(problem: RouteProblem, bendCells: readonly Int3[]): Int3[] {
  return [problem.from.pointUm, ...bendCells.map((cell) => cellPointUm(problem, cell)), problem.to.pointUm];
}

const lengthUm = (points: readonly Int3[]): number => {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const [a, b] = [points[index - 1] as Int3, points[index] as Int3];
    total += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + Math.abs(b[2] - a[2]);
  }
  return total;
};

/** The solution of a successful search. */
export function solutionFromSearch(
  problem: RouteProblem,
  problemHash: string,
  result: Extract<SearchResult, { status: 'found' }>,
  engine: string,
): RouteSolution {
  const points = polylineUm(problem, result.bendCells);
  return {
    problemHash,
    pis: result.bendCells.map((cell) => toMm(cellPointUm(problem, cell))),
    lengthMm: lengthUm(points) / 1000,
    bends: result.bends,
    cost: result.cost,
    optimal: true,
    expansions: result.expansions,
    engine,
  };
}

/** Axis index of the segment a -> b, or null when it is not a non-zero axis-aligned move. */
function axisOf(a: Int3, b: Int3): number | null {
  const delta = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const moving = delta.flatMap((value, dim) => (value === 0 ? [] : [dim]));
  if (moving.length !== 1) return null;
  const dim = moving[0] as number;
  return 2 * dim + ((delta[dim] as number) > 0 ? 0 : 1);
}

const onLattice = (problem: RouteProblem, point: Int3): Int3 | null => {
  const cell = point.map((value, dim) => (value - (problem.originUm[dim] as number)) / problem.cellUm);
  return cell.every(Number.isInteger) ? (cell as unknown as Int3) : null;
};

const inBounds = (problem: RouteProblem, cell: Int3): boolean =>
  cell.every((value, dim) => value >= (problem.bounds.min[dim] as number) && value <= (problem.bounds.max[dim] as number));

/** Cost of the lattice part (start cell -> goal cell) of the polyline. */
function latticeCost(problem: RouteProblem, cells: readonly Int3[], legAxes: readonly number[]): number {
  let cost = 0;
  for (let index = 1; index < cells.length; index++) {
    const [a, b] = [cells[index - 1] as Int3, cells[index] as Int3];
    const length = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + Math.abs(b[2] - a[2]);
    cost += moveCost(problem, length, legAxes[index - 1] as number, a[2]);
  }
  return cost + problem.bendCostUm * (legAxes.length - 1);
}

/**
 * @failure stale hash, off-axis / zero / reversed / unmerged leg, PI off the lattice or outside the grid box, stub or leg shorter than
 *   the problem allows, a leg through an obstacle, or length / bends / cost not matching the PIs -> `{ ok: false, reason, path }`
 */
export function checkSolution(problem: RouteProblem, problemHash: string, solution: RouteSolution): SolutionCheck {
  const fail = (reason: string, path: string): SolutionCheck => ({ ok: false, reason, path });
  if (solution.problemHash !== problemHash)
    return fail(`stale problemHash ${solution.problemHash} (the current problem hashes to ${problemHash})`, 'solution.problemHash');
  const points: Int3[] = [problem.from.pointUm, ...solution.pis.map((p) => p.map(um) as unknown as Int3), problem.to.pointUm];
  const axes: number[] = [];
  for (let leg = 0; leg + 1 < points.length; leg++) {
    const axis = axisOf(points[leg] as Int3, points[leg + 1] as Int3);
    if (axis === null) return fail(`leg ${leg} is zero or not axis-aligned`, `solution.pis.${leg}`);
    const previous = axes[leg - 1];
    if (previous === axis) return fail(`legs ${leg - 1} and ${leg} are collinear (merge them)`, `solution.pis.${leg - 1}`);
    if (previous !== undefined && previous === (axis ^ 1)) return fail(`leg ${leg} reverses leg ${leg - 1}`, `solution.pis.${leg - 1}`);
    axes.push(axis);
  }
  const last = axes.length - 1;
  if (axes[0] !== problem.from.axis) return fail('the first leg does not leave along the from port direction', 'solution.pis');
  if (axes[last] !== problem.to.axis) return fail('the last leg does not arrive along the to port direction', 'solution.pis');
  const startCell = along(problem.from.pointUm, problem.from.axis, problem.from.stubUm);
  const goalCell = along(problem.to.pointUm, problem.to.axis ^ 1, problem.to.stubUm);
  const legLength = (leg: number): number => lengthUm([points[leg] as Int3, points[leg + 1] as Int3]);
  if (legLength(0) < problem.from.stubUm) return fail(`leg 0 is shorter than the from stub (${problem.from.stubUm} µm)`, 'solution.pis.0');
  if (legLength(last) < problem.to.stubUm) return fail(`leg ${last} is shorter than the to stub (${problem.to.stubUm} µm)`, `solution.pis`);
  const cells: Int3[] = [];
  for (const point of [startCell, ...points.slice(1, -1), goalCell]) {
    const cell = onLattice(problem, point);
    if (cell === null || !inBounds(problem, cell))
      return fail(`point [${toMm(point).join(', ')}] is off the lattice or outside the grid box`, 'solution.pis');
    cells.push(cell);
  }
  for (let leg = 1; leg <= last; leg++) {
    const latticeCells = lengthUm([cells[leg] as Int3, cells[leg + 1] as Int3]);
    if (latticeCells < problem.minLegCells)
      return fail(`leg ${leg} is shorter than ${problem.minLegCells} cells (two elbows)`, `solution.pis.${leg - 1}`);
  }
  const lattice = [startCell, ...points.slice(1, -1), goalCell];
  for (let leg = 0; leg <= last; leg++) {
    const [a, b] = [lattice[leg] as Int3, lattice[leg + 1] as Int3];
    const axis = axisOf(a, b);
    if (axis === null ? lengthUm([a, b]) !== 0 : axis !== axes[leg])
      return fail(`leg ${leg} runs against its stub`, `solution.pis.${Math.min(leg, solution.pis.length - 1)}`);
    const blocking = firstBlocking(a, b, problem.obstacles);
    if (blocking !== null)
      return fail(`leg ${leg} enters obstacle ${blocking.id}`, `solution.pis.${Math.min(leg, solution.pis.length - 1)}`);
  }
  const total = lengthUm(points);
  if (Math.abs(solution.lengthMm * 1000 - total) > 1e-3)
    return fail(`lengthMm ${solution.lengthMm} != ${total / 1000}`, 'solution.lengthMm');
  if (solution.bends !== axes.length - 1) return fail(`bends ${solution.bends} != ${axes.length - 1}`, 'solution.bends');
  const cost = latticeCost(problem, cells, axes);
  if (solution.cost !== cost) return fail(`cost ${solution.cost} != ${cost} recomputed from the PIs`, 'solution.cost');
  return { ok: true };
}
