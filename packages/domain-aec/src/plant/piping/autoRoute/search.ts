/**
 * Reference search of the auto-router (02 RTE §5.12, §13.12): A* over states (cell, incoming axis); a straight move is one cell, a turn
 * moves `minLegCells` cells along the new axis (so every leg that starts with a bend fits two elbows); reversals are never generated. The open
 * set is ordered by the total key (f, h, i, j, k, axis), so any correct heap gives the same expansion order; a state is expanded again only
 * when a strictly cheaper g reaches it.
 *
 * Candidates. The start state has up to five first moves (every axis but the reverse of the port); each is a candidate: an A* of its own whose
 * first expansion makes only that move. The best route over the candidates wins, ties by the lowest first-move axis index. A candidate
 * stops generating states costlier than the best route already known (lexicographic (cost, index), so a later candidate cannot win a tie); this
 * never changes the winner or the winner's expansion count. `solver/crates/llull-route` runs the same candidates on a rayon pool (VC-RTE-25).
 */

import { AXIS_VECTORS, firstBlocking, heuristic, moveCost, type Int3, type RouteProblem } from './lattice';

/** Search outcome. `optimal` is false when a candidate that could still hold a cheaper (or equal and earlier) route ran out of budget. */
export type SearchResult =
  | {
      readonly status: 'found';
      /** Lattice cells where the route bends, in route order. */
      readonly bendCells: readonly Int3[];
      readonly cost: number;
      readonly bends: number;
      /** Expansions of the winning candidate (the first expansion included). */
      readonly expansions: number;
      /** Axis index (0..5) of the winning first move. */
      readonly candidate: number;
      readonly optimal: boolean;
    }
  | { readonly status: 'no_path' | 'budget'; readonly expansions: number };

/** [f, h, i, j, k, axis, g]: compared lexicographically on the first six fields. */
type Entry = readonly [number, number, number, number, number, number, number];

const less = (a: Entry, b: Entry): boolean => {
  for (let index = 0; index < 6; index++) {
    const x = a[index] as number;
    const y = b[index] as number;
    if (x !== y) return x < y;
  }
  return false;
};

class EntryHeap {
  private readonly items: Entry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: Entry): void {
    const items = this.items;
    items.push(entry);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!less(items[index] as Entry, items[parent] as Entry)) break;
      [items[index], items[parent]] = [items[parent] as Entry, items[index] as Entry];
      index = parent;
    }
  }

  pop(): Entry | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        let smallest = index;
        if (left < items.length && less(items[left] as Entry, items[smallest] as Entry)) smallest = left;
        if (left + 1 < items.length && less(items[left + 1] as Entry, items[smallest] as Entry)) smallest = left + 1;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest] as Entry, items[index] as Entry];
        index = smallest;
      }
    }
    return top;
  }
}

/** What one candidate (one first move) returned. */
type CandidateOutcome =
  | {
      readonly kind: 'found';
      readonly bendCells: readonly Int3[];
      readonly bends: number;
      readonly cost: number;
      readonly expansions: number;
    }
  | { readonly kind: 'exhausted'; readonly expansions: number }
  | { readonly kind: 'budget'; readonly expansions: number; readonly lowerBound: number };

/** Best route known so far: candidates compare (cost, first-move axis index) lexicographically. */
interface Bound {
  readonly cost: number;
  readonly index: number;
}

/** The grid arithmetic of a problem, shared by every candidate. */
class Grid {
  readonly size: Int3;

  constructor(readonly problem: RouteProblem) {
    const { bounds } = problem;
    this.size = [bounds.max[0] - bounds.min[0] + 1, bounds.max[1] - bounds.min[1] + 1, bounds.max[2] - bounds.min[2] + 1];
  }

  keyOf(i: number, j: number, k: number, axis: number): number {
    const { bounds } = this.problem;
    return (((i - bounds.min[0]) * this.size[1] + (j - bounds.min[1])) * this.size[2] + (k - bounds.min[2])) * 6 + axis;
  }

  inside(i: number, j: number, k: number): boolean {
    const { bounds } = this.problem;
    return i >= bounds.min[0] && i <= bounds.max[0] && j >= bounds.min[1] && j <= bounds.max[1] && k >= bounds.min[2] && k <= bounds.max[2];
  }

  pointUm(i: number, j: number, k: number): Int3 {
    const { originUm, cellUm } = this.problem;
    return [originUm[0] + i * cellUm, originUm[1] + j * cellUm, originUm[2] + k * cellUm];
  }

  /** The cell reached by move `next` from (i, j, k) travelling `axis`, or null when it leaves the box or enters an obstacle. */
  target(i: number, j: number, k: number, axis: number, next: number): Int3 | null {
    const step = next === axis ? 1 : this.problem.minLegCells;
    const [dx, dy, dz] = AXIS_VECTORS[next] as Int3;
    const [ni, nj, nk] = [i + dx * step, j + dy * step, k + dz * step];
    if (!this.inside(ni, nj, nk)) return null;
    return firstBlocking(this.pointUm(i, j, k), this.pointUm(ni, nj, nk), this.problem.obstacles) === null ? [ni, nj, nk] : null;
  }
}

/** The entry of the move `next` out of a state at height `k`, travelling `axis`, with cost `g`. */
function moveEntry(grid: Grid, k: number, axis: number, g: number, next: number, cell: Int3): Entry {
  const { problem } = grid;
  const step = next === axis ? 1 : problem.minLegCells;
  const ng = g + moveCost(problem, step, next, k) + (next === axis ? 0 : problem.bendCostUm);
  const h = heuristic(problem, cell, next);
  return [ng + h, h, cell[0], cell[1], cell[2], next, ng];
}

/** Valid first moves out of the start state with the f of their entry, in axis order. */
function firstMoves(grid: Grid): { index: number; f: number }[] {
  const { problem } = grid;
  const moves: { index: number; f: number }[] = [];
  for (let next = 0; next < 6; next++) {
    if (next === (problem.from.axis ^ 1)) continue;
    const cell = grid.target(0, 0, 0, problem.from.axis, next);
    if (cell !== null) moves.push({ index: next, f: (moveEntry(grid, 0, problem.from.axis, 0, next, cell) as Entry)[0] });
  }
  return moves;
}

/** A* of one candidate: the start state is expanded once, with the move `first` only. */
function searchCandidate(grid: Grid, first: number, maxExpansions: number, bound: Bound | null): CandidateOutcome {
  const { problem } = grid;
  const best = new Map<number, number>();
  const parent = new Map<number, number>();
  const heap = new EntryHeap();
  const startAxis = problem.from.axis;
  const startKey = grid.keyOf(0, 0, 0, startAxis);
  const goalKey = grid.keyOf(problem.goal.cell[0], problem.goal.cell[1], problem.goal.cell[2], problem.goal.axis);
  const h0 = heuristic(problem, [0, 0, 0], startAxis);
  if (maxExpansions < 1) return { kind: 'budget', expansions: 0, lowerBound: h0 };
  best.set(startKey, 0);
  let expansions = 1;
  const pruned = (f: number): boolean => bound !== null && (f > bound.cost || (f === bound.cost && first > bound.index));
  const push = (entry: Entry, from: number): void => {
    if (pruned(entry[0])) return;
    const key = grid.keyOf(entry[2], entry[3], entry[4], entry[5]);
    const known = best.get(key);
    if (known !== undefined && known <= entry[6]) return;
    best.set(key, entry[6]);
    parent.set(key, from);
    heap.push(entry);
  };
  const firstCell = grid.target(0, 0, 0, startAxis, first);
  if (firstCell === null) return { kind: 'exhausted', expansions };
  push(moveEntry(grid, 0, startAxis, 0, first, firstCell), startKey);
  while (heap.size > 0) {
    const [f, , i, j, k, axis, g] = heap.pop() as Entry;
    const key = grid.keyOf(i, j, k, axis);
    if (g !== best.get(key)) continue;
    if (key === goalKey) {
      const route = unwind(key, parent, grid.size, problem.bounds.min, startKey);
      return { kind: 'found', ...route, cost: g, expansions };
    }
    if (expansions === maxExpansions) return { kind: 'budget', expansions, lowerBound: f };
    expansions++;
    for (let next = 0; next < 6; next++) {
      if (next === (axis ^ 1)) continue;
      const cell = grid.target(i, j, k, axis, next);
      if (cell !== null) push(moveEntry(grid, k, axis, g, next, cell), key);
    }
  }
  return { kind: 'exhausted', expansions };
}

/**
 * Searches every first-move candidate (cheapest first entry first; the order never changes the result) and keeps the best route.
 * `maxExpansions` is the budget of each candidate. A start cell that already is the goal state is the trivial straight route.
 * @invariant identical (problem, maxExpansions) -> identical result, field for field, in TypeScript and in llull-route
 */
export function searchRoute(problem: RouteProblem, maxExpansions: number): SearchResult {
  const grid = new Grid(problem);
  const startKey = grid.keyOf(0, 0, 0, problem.from.axis);
  if (startKey === grid.keyOf(problem.goal.cell[0], problem.goal.cell[1], problem.goal.cell[2], problem.goal.axis))
    return { status: 'found', bendCells: [], cost: 0, bends: 0, expansions: 0, candidate: problem.from.axis, optimal: true };
  const order = firstMoves(grid).sort((a, b) => a.f - b.f || a.index - b.index);
  let bound: Bound | null = null;
  let winner: Extract<CandidateOutcome, { kind: 'found' }> | null = null;
  const stopped: { index: number; lowerBound: number }[] = [];
  let total = 0;
  for (const { index } of order) {
    const outcome = searchCandidate(grid, index, maxExpansions, bound);
    total += outcome.expansions;
    if (outcome.kind === 'budget') stopped.push({ index, lowerBound: outcome.lowerBound });
    if (outcome.kind === 'found') {
      winner = outcome;
      bound = { cost: outcome.cost, index };
    }
  }
  if (winner === null || bound === null) return { status: stopped.length > 0 ? 'budget' : 'no_path', expansions: total };
  const { cost, index } = bound;
  const optimal = !stopped.some((s) => s.lowerBound < cost || (s.lowerBound === cost && s.index < index));
  return {
    status: 'found',
    bendCells: winner.bendCells,
    cost,
    bends: winner.bends,
    expansions: winner.expansions,
    candidate: index,
    optimal,
  };
}

function unwind(
  goalKey: number,
  parent: ReadonlyMap<number, number>,
  size: Int3,
  min: Int3,
  startKey: number,
): { bendCells: Int3[]; bends: number } {
  const decode = (key: number): { cell: Int3; axis: number } => {
    const axis = key % 6;
    let rest = (key - axis) / 6;
    const k = rest % size[2];
    rest = (rest - k) / size[2];
    const j = rest % size[1];
    const i = (rest - j) / size[1];
    return { cell: [i + min[0], j + min[1], k + min[2]], axis };
  };
  const states: { cell: Int3; axis: number }[] = [];
  let key: number | undefined = goalKey;
  while (key !== undefined) {
    states.push(decode(key));
    key = key === startKey ? undefined : parent.get(key);
  }
  states.reverse();
  const bendCells: Int3[] = [];
  for (let index = 1; index < states.length; index++) {
    const previous = states[index - 1] as { cell: Int3; axis: number };
    if ((states[index] as { axis: number }).axis !== previous.axis) bendCells.push(previous.cell);
  }
  return { bendCells, bends: bendCells.length };
}
