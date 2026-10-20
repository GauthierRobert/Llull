/**
 * The canonical auto-route problem (02 RTE §2.A, §5.12): every length is an integer number of micrometres so the TypeScript reference
 * and the native `llull-route` search add exact integers and expand states in the same order. Shared by the problem builder, the
 * reference A* and the solution validator; the Rust crate `solver/crates/llull-route` mirrors these definitions field for field.
 */

export type Int3 = readonly [number, number, number];

/** Axis order +X, -X, +Y, -Y, +Z, -Z: the move order and the last tie-break key (AF-13). `axis ^ 1` is the reverse direction. */
export const AXIS_VECTORS: readonly Int3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export const AXIS_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;

/** An inflated obstacle or keep-out box (µm, world). A leg is blocked when it enters the open box: touching a face is clear. */
export interface ObstacleBox {
  readonly id: string;
  readonly min: Int3;
  readonly max: Int3;
}

/** A port end of the problem: its world point, the axis of its stub and the stub length (both µm). */
export interface ProblemEnd {
  readonly pointUm: Int3;
  /** Travel axis of the pipe along the stub: away from the `from` port, toward the `to` port. */
  readonly axis: number;
  readonly stubUm: number;
}

/**
 * Lattice search problem. Lattice points are `originUm + cell * cellUm`; the start cell is [0, 0, 0] (end of the `from` stub) and the
 * goal is `goal.cell` (start of the `to` stub), reached travelling `goal.axis`.
 */
export interface RouteProblem {
  readonly version: 1;
  readonly cellUm: number;
  readonly originUm: Int3;
  /** Inclusive cell-index box the search stays in. */
  readonly bounds: { readonly min: Int3; readonly max: Int3 };
  readonly from: ProblemEnd;
  readonly to: ProblemEnd;
  readonly goal: { readonly cell: Int3; readonly axis: number };
  /** A leg that starts with a bend is at least this many cells long (room for two elbow centre-to-ends). */
  readonly minLegCells: number;
  readonly bendCostUm: number;
  /** Cell z indices of preferred (rack) elevations; empty = no preference. */
  readonly preferredK: readonly number[];
  /** Extra cost per horizontal cell travelled off every preferred elevation (0 when `preferredK` is empty). */
  readonly offElevationPenaltyPerCellUm: number;
  readonly obstacles: readonly ObstacleBox[];
}

export const cellPointUm = (problem: RouteProblem, cell: Int3): Int3 => [
  problem.originUm[0] + cell[0] * problem.cellUm,
  problem.originUm[1] + cell[1] * problem.cellUm,
  problem.originUm[2] + cell[2] * problem.cellUm,
];

/** True when the axis-aligned segment a-b enters the open box (strict on the fixed axes, open-interval overlap on the moving one). */
export function segmentBlocked(a: Int3, b: Int3, box: ObstacleBox): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.min(a[axis] as number, b[axis] as number);
    const hi = Math.max(a[axis] as number, b[axis] as number);
    const min = box.min[axis] as number;
    const max = box.max[axis] as number;
    if (!(lo < max && hi > min)) return false;
  }
  return true;
}

/** The first obstacle the segment enters, or null. */
export function firstBlocking(a: Int3, b: Int3, obstacles: readonly ObstacleBox[]): ObstacleBox | null {
  for (const box of obstacles) if (segmentBlocked(a, b, box)) return box;
  return null;
}

const popcount6 = (mask: number): number => {
  let count = 0;
  for (let bit = 0; bit < 6; bit++) if ((mask >> bit) & 1) count++;
  return count;
};

/**
 * Lower bound on the bends left (admissible): every signed direction still needed to close the offset, plus the arrival direction,
 * must be travelled; the current direction is free.
 */
export function minBends(cell: Int3, axis: number, goal: Int3, arrival: number): number {
  let needed = 1 << arrival;
  for (let dim = 0; dim < 3; dim++) {
    const delta = (goal[dim] as number) - (cell[dim] as number);
    if (delta !== 0) needed |= 1 << (2 * dim + (delta > 0 ? 0 : 1));
  }
  return popcount6(needed) - ((needed >> axis) & 1);
}

/** h = Manhattan distance (µm) + bend cost x the bend lower bound. */
export function heuristic(problem: RouteProblem, cell: Int3, axis: number): number {
  const goal = problem.goal.cell;
  const cells = Math.abs(goal[0] - cell[0]) + Math.abs(goal[1] - cell[1]) + Math.abs(goal[2] - cell[2]);
  return cells * problem.cellUm + problem.bendCostUm * minBends(cell, axis, goal, problem.goal.axis);
}

/** Cost of travelling `cells` along `axis` at cell height `k`, without the bend cost. */
export function moveCost(problem: RouteProblem, cells: number, axis: number, k: number): number {
  const horizontal = axis < 4;
  const off = horizontal && problem.preferredK.length > 0 && !problem.preferredK.includes(k);
  return cells * problem.cellUm + (off ? cells * problem.offElevationPenaltyPerCellUm : 0);
}
