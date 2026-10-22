/**
 * Evaluation of a `ScalarLaw`: value at an arc-length fraction, validation, and positivity. A `table` is a shape-preserving cubic Hermite (C1,
 * monotone between data: no overshoot, so a positive table stays positive) through its (t, value) points, with the end slopes of `startSlope` /
 * `endSlope` when given; an `expression` runs a compiled program.
 */

import { compileExpression, programFunction, type Program } from '../expressionProgram';
import { LAW_VARIABLES, type LawIssue, type ScalarLaw } from './types';

/** Samples used to check positivity of scale / area / pitch laws (plus the table knots). */
const POSITIVITY_SAMPLES = 256;

type Table = Extract<ScalarLaw, { type: 'table' }>;

/** Slopes at the knots of the shape-preserving cubic through `table` (Fritsch-Carlson / Butland): zero at extrema, so no overshoot between data. */
function knotSlopes(table: Table): number[] {
  const t = table.points.map((p) => p[0]);
  const y = table.points.map((p) => p[1]);
  const n = t.length;
  const h = (i: number): number => (t[i + 1] as number) - (t[i] as number);
  const secant = (i: number): number => ((y[i + 1] as number) - (y[i] as number)) / h(i);
  const d = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const [left, right] = [secant(i - 1), secant(i)];
    if (left * right > 0) {
      const [w1, w2] = [2 * h(i) + h(i - 1), h(i) + 2 * h(i - 1)];
      d[i] = (w1 + w2) / (w1 / left + w2 / right);
    }
  }
  const end = (h0: number, h1: number, s0: number, s1: number): number => {
    const slope = ((2 * h0 + h1) * s0 - h0 * s1) / (h0 + h1);
    if (slope * s0 <= 0) return 0;
    return s0 * s1 <= 0 && Math.abs(slope) > 3 * Math.abs(s0) ? 3 * s0 : slope;
  };
  d[0] = table.startSlope ?? (n === 2 ? secant(0) : end(h(0), h(1), secant(0), secant(1)));
  d[n - 1] = table.endSlope ?? (n === 2 ? secant(0) : end(h(n - 2), h(n - 3), secant(n - 2), secant(n - 3)));
  return d;
}

function tableFunction(table: Table): (t: number) => number {
  const slopes = knotSlopes(table);
  const pts = table.points;
  return (x) => {
    let i = 0;
    while (i < pts.length - 2 && x > (pts[i + 1] as readonly [number, number])[0]) i++;
    const [t0, y0] = pts[i] as readonly [number, number];
    const [t1, y1] = pts[i + 1] as readonly [number, number];
    const h = t1 - t0;
    const s = (x - t0) / h;
    const [s2, s3] = [s * s, s * s * s];
    return (
      (2 * s3 - 3 * s2 + 1) * y0 +
      (s3 - 2 * s2 + s) * h * (slopes[i] as number) +
      (-2 * s3 + 3 * s2) * y1 +
      (s3 - s2) * h * (slopes[i + 1] as number)
    );
  };
}

/** Why `law` cannot be evaluated (shape, ordering, finiteness, expression syntax), or null. */
function structuralIssue(law: ScalarLaw): LawIssue | null {
  const invalid = (message: string): LawIssue => ({ code: 'SWG_LAW_INVALID', message });
  const finite = (...values: number[]): boolean => values.every(Number.isFinite);
  switch (law.type) {
    case 'constant':
      return finite(law.value) ? null : invalid('constant value must be finite');
    case 'linear':
    case 's_curve':
      return finite(law.start, law.end) ? null : invalid(`${law.type} start and end must be finite`);
    case 'expression': {
      const program = compileExpression(law.expression, LAW_VARIABLES);
      return typeof program === 'string' ? invalid(`expression "${law.expression}": ${program}`) : null;
    }
    case 'table': {
      const pts = law.points;
      if (pts.length < 2) return invalid('table needs >= 2 points');
      if (!pts.every(([t, v]) => finite(t, v))) return invalid('table points must be finite');
      const bad = pts.findIndex((p, i) => i > 0 && p[0] <= (pts[i - 1] as readonly [number, number])[0]);
      if (bad > 0) return invalid(`table t must be strictly increasing (points.${bad})`);
      if ((pts[0] as readonly [number, number])[0] !== 0 || (pts[pts.length - 1] as readonly [number, number])[0] !== 1)
        return invalid('table t must start at 0 and end at 1');
      return finite(law.startSlope ?? 0, law.endSlope ?? 0) ? null : invalid('table end slopes must be finite');
    }
  }
}

/** The law as a function of (t, L); only valid after `lawIssue` returned null. */
export function lawFunction(law: ScalarLaw): (t: number, length: number) => number {
  switch (law.type) {
    case 'constant':
      return () => law.value;
    case 'linear':
      return (t) => law.start + (law.end - law.start) * t;
    case 's_curve':
      return (t) => law.start + (law.end - law.start) * t * t * (3 - 2 * t);
    case 'table': {
      const spline = tableFunction(law);
      return (t) => spline(t);
    }
    case 'expression': {
      const run = programFunction(compileExpression(law.expression, LAW_VARIABLES) as Program);
      return (t, length) => run([t, t * length, length]);
    }
  }
}

/** Abscissae worth checking besides the uniform samples: the table knots. */
export function lawKnots(law: ScalarLaw): number[] {
  return law.type === 'table' ? law.points.map((p) => p[0]) : [0, 1];
}

/**
 * First problem of `law`: structure, a non-finite sample (SWG_LAW_INVALID, with t) or, with `positive`, a value <= 0 (SWG_LAW_NONPOSITIVE).
 * `length` feeds the expression variables `s` and `L`.
 */
export function lawIssue(law: ScalarLaw, options: { readonly positive: boolean; readonly length: number }): LawIssue | null {
  const structural = structuralIssue(law);
  if (structural !== null) return structural;
  const f = lawFunction(law);
  const ts = [...lawKnots(law), ...Array.from({ length: POSITIVITY_SAMPLES + 1 }, (_, k) => k / POSITIVITY_SAMPLES)];
  for (const t of ts) {
    const v = f(t, options.length);
    if (!Number.isFinite(v)) return { code: 'SWG_LAW_INVALID', message: `law is not finite at t=${t}`, t };
    if (options.positive && !(v > 0)) return { code: 'SWG_LAW_NONPOSITIVE', message: `law value ${v} <= 0 at t=${t}`, t };
  }
  return null;
}
