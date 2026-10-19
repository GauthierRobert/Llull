import type { Layout } from './layout';
import { at, jacobiSvd, rankTolerance, transpose } from './linalg';
import { jacobian, type Problem } from './problem';

/** Constraints (by index into `problem.compiled`) whose rows are linearly dependent with the rows of one constraint. */
export interface Dependencies {
  /** True when the constraint's own rows are dependent among themselves (it restricts nothing new). */
  readonly selfRedundant: boolean;
  readonly others: readonly number[];
}

export interface Analysis {
  readonly rank: number;
  /** Variables of the sketch minus rank(J). */
  readonly dof: number;
  /** Entities none of whose variables can move without breaking a constraint. */
  readonly fullyConstrained: readonly string[];
  readonly dependenciesOf: (constraintIndex: number) => Dependencies;
}

const NULL_WEIGHT = 1e-6;

/** Rank, degrees of freedom and per-entity constraint status of the sketch at `x`. */
export function analyze(problem: Problem, layout: Layout, x: Float64Array): Analysis {
  const n = problem.active.length;
  const m = problem.rows;
  const jac = n > 0 && m > 0 ? jacobian(problem, x) : new Float64Array(0);
  const svd = n > 0 && m > 0 ? jacobiSvd(jac, m, n) : null;
  const tolerance = svd ? rankTolerance(svd.values) : 0;
  const rank = svd ? svd.values.filter((value) => value > tolerance).length : 0;
  const slack = new Float64Array(layout.x0.length).fill(1);
  if (svd) {
    problem.active.forEach((variable, row) => {
      let weight = 0;
      for (let k = 0; k < n; k++) if (at(svd.values, k) <= tolerance) weight += at(svd.vectors, row * n + k) ** 2;
      slack[variable] = weight;
    });
  } else {
    problem.active.forEach((variable) => {
      slack[variable] = 1;
    });
  }
  const loose = new Set<string>();
  layout.owner.forEach((id, variable) => {
    if (at(slack, variable) > NULL_WEIGHT) loose.add(id);
  });
  const fullyConstrained = [...layout.blocks.keys()].filter((id) => !loose.has(id));
  let left: { values: Float64Array; vectors: Float64Array } | null | undefined;
  const dependenciesOf = (constraintIndex: number): Dependencies => {
    if (left === undefined) left = m > 0 && n > 0 ? jacobiSvd(transpose(jac, m, n), n, m) : null;
    const target = problem.compiled[constraintIndex];
    if (!left || !target) return { selfRedundant: false, others: [] };
    const nullColumns = Array.from({ length: m }, (_, k) => k).filter((k) => at(left?.values ?? [], k) <= tolerance);
    const weight = (i: number, r: number): number =>
      nullColumns.reduce((sum, k) => sum + at(left?.vectors ?? [], i * m + k) * at(left?.vectors ?? [], r * m + k), 0);
    const first = at(problem.rowStart, constraintIndex);
    const rows = Array.from({ length: target.rows }, (_, k) => first + k);
    const selfRedundant = rows.some((r) => weight(r, r) > NULL_WEIGHT);
    const others = problem.compiled.flatMap((_, index) => {
      if (index === constraintIndex) return [];
      const start = at(problem.rowStart, index);
      const related = rows.some((r) =>
        Array.from({ length: problem.compiled[index]?.rows ?? 0 }, (_, k) => start + k).some((i) => Math.abs(weight(i, r)) > NULL_WEIGHT),
      );
      return related ? [index] : [];
    });
    return { selfRedundant, others };
  };
  return { rank, dof: layout.x0.length - rank, fullyConstrained, dependenciesOf };
}
