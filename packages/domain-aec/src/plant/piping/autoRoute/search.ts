/**
 * Reference A* of the auto-router (02 RTE §5.12): state = (cell, incoming axis); a straight move is one cell, a turn moves
 * `minLegCells` cells along the new axis (so every leg that starts with a bend fits two elbows); reversals are never generated. The
 * open set is ordered by the total key (f, h, i, j, k, axis), so any correct heap gives the same expansion order; a state is expanded
 * again only when a strictly cheaper g reaches it. `solver/crates/llull-route` implements the same search (VC-RTE-25).
 */

import { AXIS_VECTORS, firstBlocking, heuristic, moveCost, type Int3, type RouteProblem } from './lattice';

export type SearchResult =
  | {
      readonly status: 'found';
      /** Lattice cells where the route bends, in route order. */
      readonly bendCells: readonly Int3[];
      readonly cost: number;
      readonly bends: number;
      readonly expansions: number;
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

/**
 * Runs A* until the goal state is popped, the open set empties (`no_path`) or `maxExpansions` states were expanded (`budget`).
 * @invariant identical (problem, maxExpansions) -> identical result, field for field, in TypeScript and in llull-route
 */
export function searchRoute(problem: RouteProblem, maxExpansions: number): SearchResult {
  const { bounds, goal, cellUm, obstacles } = problem;
  const size: Int3 = [bounds.max[0] - bounds.min[0] + 1, bounds.max[1] - bounds.min[1] + 1, bounds.max[2] - bounds.min[2] + 1];
  const keyOf = (i: number, j: number, k: number, axis: number): number =>
    (((i - bounds.min[0]) * size[1] + (j - bounds.min[1])) * size[2] + (k - bounds.min[2])) * 6 + axis;
  const best = new Map<number, number>();
  const parent = new Map<number, number>();
  const heap = new EntryHeap();
  const startAxis = problem.from.axis;
  const startKey = keyOf(0, 0, 0, startAxis);
  best.set(startKey, 0);
  const h0 = heuristic(problem, [0, 0, 0], startAxis);
  heap.push([h0, h0, 0, 0, 0, startAxis, 0]);
  let expansions = 0;
  const goalKey = keyOf(goal.cell[0], goal.cell[1], goal.cell[2], goal.axis);
  const inside = (i: number, j: number, k: number): boolean =>
    i >= bounds.min[0] && i <= bounds.max[0] && j >= bounds.min[1] && j <= bounds.max[1] && k >= bounds.min[2] && k <= bounds.max[2];
  const pointUm = (i: number, j: number, k: number): Int3 => [
    problem.originUm[0] + i * cellUm,
    problem.originUm[1] + j * cellUm,
    problem.originUm[2] + k * cellUm,
  ];
  while (heap.size > 0) {
    const [, , i, j, k, axis, g] = heap.pop() as Entry;
    const key = keyOf(i, j, k, axis);
    if (g !== best.get(key)) continue;
    if (key === goalKey) return { status: 'found', ...unwind(key, parent, size, bounds.min, startKey), cost: g, expansions };
    if (expansions === maxExpansions) return { status: 'budget', expansions };
    expansions++;
    const here = pointUm(i, j, k);
    for (let next = 0; next < 6; next++) {
      if (next === (axis ^ 1)) continue;
      const step = next === axis ? 1 : problem.minLegCells;
      const [dx, dy, dz] = AXIS_VECTORS[next] as Int3;
      const [ni, nj, nk] = [i + dx * step, j + dy * step, k + dz * step];
      if (!inside(ni, nj, nk)) continue;
      if (firstBlocking(here, pointUm(ni, nj, nk), obstacles) !== null) continue;
      const ng = g + moveCost(problem, step, next, k) + (next === axis ? 0 : problem.bendCostUm);
      const nextKey = keyOf(ni, nj, nk, next);
      const known = best.get(nextKey);
      if (known !== undefined && known <= ng) continue;
      best.set(nextKey, ng);
      parent.set(nextKey, key);
      const h = heuristic(problem, [ni, nj, nk], next);
      heap.push([ng + h, h, ni, nj, nk, next, ng]);
    }
  }
  return { status: 'no_path', expansions };
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
