import type { Compiled } from './compileContext';
import { featureSize, type Layout } from './layout';
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
  /** Finite-difference step of each active variable, sized to the entity that owns it. */
  readonly steps: readonly number[];
}

/** One Jacobian row: `idx` are positions in `Problem.active`, ascending. */
export interface SparseRow {
  readonly idx: number[];
  readonly val: number[];
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
    for (const id of c.entities) {
      const list = byEntity.get(id);
      if (list) list.push(index);
      else byEntity.set(id, [index]);
    }
  });
  const active: number[] = [];
  const readers: number[][] = [];
  const steps: number[] = [];
  layout.owner.forEach((id, variable) => {
    const list = byEntity.get(id);
    const block = layout.blocks.get(id);
    const holdsGeometry = block !== undefined && variable >= block.offset && variable < block.offset + block.size;
    if (list && !(frozen.has(id) && holdsGeometry)) {
      active.push(variable);
      readers.push(list);
      steps.push(Math.max(1e-6 * Math.max(featureSize(layout, id), 1e-3), 1e-8 * Math.abs(at(layout.x0, variable))));
    }
  });
  return { compiled, rows, rowStart, active, readers, steps };
}

export function residualVector(problem: Problem, x: Float64Array): Float64Array {
  const out = new Float64Array(problem.rows);
  problem.compiled.forEach((c, index) => c.evaluate(x, out, at(problem.rowStart, index)));
  return out;
}

/** Sum of squared residuals. */
export function cost(problem: Problem, x: Float64Array): number {
  let sum = 0;
  for (const value of residualVector(problem, x)) sum += value * value;
  return sum;
}

/** Sparse Jacobian (one row per residual, columns = active variables) by central differences over the constraints that read each variable. */
export function jacobian(problem: Problem, x: Float64Array): SparseRow[] {
  const rows: SparseRow[] = Array.from({ length: problem.rows }, () => ({ idx: [], val: [] }));
  const plus = new Float64Array(problem.rows);
  const minus = new Float64Array(problem.rows);
  const probe = Float64Array.from(x);
  problem.active.forEach((variable, column) => {
    const base = at(x, variable);
    const step = at(problem.steps, column);
    for (const index of problem.readers[column] ?? []) {
      const c = problem.compiled[index];
      if (!c) continue;
      const start = at(problem.rowStart, index);
      probe[variable] = base + step;
      c.evaluate(probe, plus, start);
      probe[variable] = base - step;
      c.evaluate(probe, minus, start);
      for (let row = start; row < start + c.rows; row++) {
        const derivative = (at(plus, row) - at(minus, row)) / (2 * step);
        if (Math.abs(derivative) > 1e-13) {
          rows[row]?.idx.push(column);
          rows[row]?.val.push(derivative);
        }
      }
    }
    probe[variable] = base;
  });
  return rows;
}
