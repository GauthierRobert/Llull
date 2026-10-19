import type { Compiled } from './compileContext';
import type { Layout } from './layout';
import { at } from './linalg';

/** Compiled residual rows over the layout's variables; only variables that some constraint touches are free to move ("active"). */
export interface Problem {
  readonly compiled: readonly Compiled[];
  readonly rows: number;
  readonly rowStart: readonly number[];
  /** Indices (into the layout vector) of the active variables, ascending. */
  readonly active: readonly number[];
  /** Constraint indices that read each active variable. */
  readonly readers: readonly (readonly number[])[];
}

export function buildProblem(layout: Layout, compiled: readonly Compiled[], frozen: ReadonlySet<string> = new Set()): Problem {
  const rowStart: number[] = [];
  let rows = 0;
  for (const c of compiled) {
    rowStart.push(rows);
    rows += c.rows;
  }
  const byEntity = new Map<string, number[]>();
  compiled.forEach((c, index) => {
    for (const id of c.entities) byEntity.set(id, [...(byEntity.get(id) ?? []), index]);
  });
  const active: number[] = [];
  const readers: number[][] = [];
  layout.owner.forEach((id, variable) => {
    const list = byEntity.get(id);
    const block = layout.blocks.get(id);
    const holdsGeometry = block !== undefined && variable >= block.offset && variable < block.offset + block.size;
    if (list && !(frozen.has(id) && holdsGeometry)) {
      active.push(variable);
      readers.push(list);
    }
  });
  return { compiled, rows, rowStart, active, readers };
}

export function evaluateResiduals(problem: Problem, x: Float64Array, out: Float64Array): void {
  problem.compiled.forEach((c, index) => c.evaluate(x, out, at(problem.rowStart, index)));
}

/** Sum of squared residuals. */
export function cost(problem: Problem, x: Float64Array): number {
  const out = new Float64Array(problem.rows);
  evaluateResiduals(problem, x, out);
  let sum = 0;
  for (const value of out) sum += value * value;
  return sum;
}

/** Dense row-major Jacobian (rows × active variables) by central differences, re-evaluating only the constraints that read each variable. */
export function jacobian(problem: Problem, x: Float64Array): Float64Array {
  const n = problem.active.length;
  const matrix = new Float64Array(problem.rows * n);
  const plus = new Float64Array(problem.rows);
  const minus = new Float64Array(problem.rows);
  const probe = Float64Array.from(x);
  problem.active.forEach((variable, column) => {
    const base = at(x, variable);
    const step = 1e-6 * Math.max(1, Math.abs(base));
    for (const index of problem.readers[column] ?? []) {
      const c = problem.compiled[index];
      if (!c) continue;
      const start = at(problem.rowStart, index);
      probe[variable] = base + step;
      c.evaluate(probe, plus, start);
      probe[variable] = base - step;
      c.evaluate(probe, minus, start);
      for (let row = start; row < start + c.rows; row++) matrix[row * n + column] = (at(plus, row) - at(minus, row)) / (2 * step);
    }
    probe[variable] = base;
  });
  return matrix;
}
