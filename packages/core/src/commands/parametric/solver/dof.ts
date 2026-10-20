import type { Layout } from './layout';
import { at } from './linalg';
import { jacobian, type Problem } from './problem';
import { dependencyOnOthers, reduceRows } from './rowSpace';

export interface Analysis {
  /** rank(J) over the problem's constraints. */
  readonly rank: number;
  /** Entities of the problem none of whose variables can move without breaking a constraint. */
  readonly fullyConstrained: readonly string[];
}

const FREE_WEIGHT = 1e-6;

/** Rank and per-entity constraint status of one connected problem at `x`. */
export function analyze(problem: Problem, layout: Layout, x: Float64Array): Analysis {
  const space = reduceRows(jacobian(problem, x), problem.active.length);
  const loose = new Set<string>();
  const entities = new Set<string>();
  problem.active.forEach((variable, column) => {
    const id = layout.owner[variable];
    if (id === undefined) return;
    entities.add(id);
    if (1 - at(space.determined, column) > FREE_WEIGHT) loose.add(id);
  });
  return { rank: space.rank, fullyConstrained: [...entities].filter((id) => !loose.has(id)) };
}

/**
 * Whether the rows of constraint `focus` (an index into `problem.compiled`) are implied by the other constraints' rows at `x`, and the
 * indices of the other constraints they are combinations of.
 */
export function focusDependencies(problem: Problem, x: Float64Array, focus: number): { redundant: boolean; on: number[] } {
  const start = at(problem.rowStart, focus);
  const count = problem.compiled[focus]?.rows ?? 0;
  const result = dependencyOnOthers(
    jacobian(problem, x),
    Array.from({ length: count }, (_, k) => start + k),
    problem.active.length,
  );
  const owners = new Set<number>();
  problem.compiled.forEach((c, index) => {
    const first = at(problem.rowStart, index);
    if (index !== focus && result.on.some((row) => row >= first && row < first + c.rows)) owners.add(index);
  });
  return { redundant: result.redundant, on: [...owners] };
}
