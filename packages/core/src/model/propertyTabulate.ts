/**
 * Sampling, integration and solver tables of a property model along one variable (PHY-01 TECHNICAL_SPEC §5.8). Works in the model's
 * own units; callers convert ends with lib/quantity first and stay inside the equation range.
 */

import { evaluateForm, isFormFailure, type Point } from './propertyForms';
import type { PropertyForm, PropertyModel, PropertyVariable } from './propertyModel';

export const SOLVER_TABLE_REL_TOL = 1e-3;
const SOLVER_TABLE_MAX_POINTS = 500;
const INTEGRAL_REL_TOL = 1e-10;

export type Curve = (x: number) => number;

/** y(x) of `model` along `variable`, other variables fixed (model units); NaN where the form cannot be evaluated. */
export function curveOf(
  model: PropertyModel,
  variable: PropertyVariable,
  fixed: Point = {},
  base?: Parameters<typeof evaluateForm>[3],
): Curve {
  return (x) => {
    const result = evaluateForm(model.form, { ...fixed, [variable]: x }, undefined, base);
    return isFormFailure(result) ? Number.NaN : result.value;
  };
}

/** Points where the form is only piecewise smooth along `variable` (table nodes, piecewise breakpoints), strictly inside (a, b). */
function breakpoints(form: PropertyForm, variable: PropertyVariable, a: number, b: number): number[] {
  const found: number[] = [];
  const walk = (f: PropertyForm): void => {
    if (f.kind === 'table1d' && f.variable === variable) found.push(...f.points.map(([x]) => x));
    if (f.kind === 'table2d') {
      if (f.x.variable === variable) found.push(...f.xs);
      if (f.y.variable === variable) found.push(...f.ys);
    }
    if (f.kind === 'piecewise') {
      if (f.variable === variable) found.push(...f.segments.map((segment) => segment.upTo));
      f.segments.forEach((segment) => walk(segment.form));
    }
    if (f.kind === 'product') f.factors.forEach(walk);
    if (f.kind === 'ratioOf') walk(f.ratio);
    if (f.kind === 'rateFactor' && f.law === 'johnsonCook' && variable === 'strainRate') found.push(f.referenceRate);
  };
  walk(form);
  return [...new Set(found)].filter((x) => x > a && x < b).sort((p, q) => p - q);
}

/** Forms interpolated in log space when tabulated (the solver table bisects geometrically). */
const isLogForm = (form: PropertyForm): boolean =>
  form.kind === 'log10Polynomial' ||
  form.kind === 'nistRational' ||
  form.kind === 'arrhenius' ||
  form.kind === 'powerLaw' ||
  (form.kind === 'table1d' && form.interpolation === 'loglog') ||
  (form.kind === 'piecewise' && form.segments.every((segment) => isLogForm(segment.form)));

export function samplePoints(from: number, to: number, count: number, spacing: 'linear' | 'log'): number[] {
  if (count === 1) return [from];
  return Array.from({ length: count }, (_, i) => {
    if (i === count - 1) return to;
    const t = i / (count - 1);
    return spacing === 'log' ? from * (to / from) ** t : from + (to - from) * t;
  });
}

const KRONROD_NODES = [
  0.9914553711208126, 0.9491079123427585, 0.8648644233597691, 0.7415311855993945, 0.5860872354676911, 0.4058451513773972,
  0.20778495500789848, 0,
];
const KRONROD_WEIGHTS = [
  0.022935322010529224, 0.06309209262997856, 0.10479001032225019, 0.14065325971552592, 0.1690047266392679, 0.19035057806478542,
  0.20443294007529889, 0.20948214108472782,
];
const GAUSS_WEIGHTS = [0.1294849661688697, 0.27970539148927664, 0.3818300505051189, 0.4179591836734694];

/** Gauss-Kronrod 7/15 on [a, b]: estimate and |K15 − G7| error. */
function kronrod(f: Curve, a: number, b: number): { value: number; error: number } {
  const center = 0.5 * (a + b);
  const half = 0.5 * (b - a);
  let k15 = 0;
  let g7 = 0;
  KRONROD_NODES.forEach((node, i) => {
    const weight = KRONROD_WEIGHTS[i] ?? 0;
    const sum = node === 0 ? f(center) : f(center - half * node) + f(center + half * node);
    k15 += weight * sum;
    if (i % 2 === 1) g7 += (GAUSS_WEIGHTS[(i - 1) / 2] ?? 0) * sum;
  });
  return { value: k15 * half, error: Math.abs((k15 - g7) * half) };
}

function adaptive(f: Curve, a: number, b: number, tolerance: number, depth: number): number {
  const { value, error } = kronrod(f, a, b);
  if (!Number.isFinite(value) || error <= tolerance || depth >= 40) return value;
  const middle = 0.5 * (a + b);
  return adaptive(f, a, middle, tolerance / 2, depth + 1) + adaptive(f, middle, b, tolerance / 2, depth + 1);
}

/** ∫ y dx over [a, b], split exactly at the breakpoints, adaptive Gauss-Kronrod to 1e-10 relative. */
export function integrateModel(model: PropertyModel, variable: PropertyVariable, a: number, b: number, curve: Curve): number {
  const edges = [a, ...breakpoints(model.form, variable, a, b), b];
  const rough = edges.slice(1).reduce((sum, edge, i) => sum + Math.abs(kronrod(curve, edges[i] ?? a, edge).value), 0);
  if (!Number.isFinite(rough)) return Number.NaN;
  const tolerance = INTEGRAL_REL_TOL * Math.max(rough, Number.MIN_VALUE);
  return edges.slice(1).reduce((sum, edge, i) => {
    const start = edges[i] ?? a;
    return sum + adaptive(curve, start, edge, (tolerance * (edge - start)) / (b - a), 0);
  }, 0);
}

export interface SolverTable {
  readonly points: readonly (readonly [number, number])[];
  readonly maxRelError: number;
}

/**
 * Piecewise-linear table for solvers that interpolate linearly (CalculiX): start from the ends and breakpoints, bisect (geometrically
 * for log forms) every interval whose linear interpolation misses y at 1/4, 1/2, 3/4 by more than relTol·|y|; `maxRelError` is measured
 * on a 10× finer grid. @failure more than 500 points -> null
 */
export function tabulateModel(
  model: PropertyModel,
  variable: PropertyVariable,
  a: number,
  b: number,
  relTol: number,
  curve: Curve,
): SolverTable | null {
  const log = isLogForm(model.form) && a > 0;
  const split = (x0: number, x1: number, t: number): number => (log ? x0 * (x1 / x0) ** t : x0 + (x1 - x0) * t);
  const relError = (x0: number, y0: number, x1: number, y1: number, x: number): number => {
    const y = curve(x);
    const linear = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    return Math.abs(linear - y) / Math.max(Math.abs(y), Number.MIN_VALUE);
  };
  const xs = [a, ...breakpoints(model.form, variable, a, b), b];
  const points: [number, number][] = xs.map((x) => [x, curve(x)]);
  for (let i = 0; i < points.length - 1; ) {
    const [x0, y0] = points[i] ?? [a, 0];
    const [x1, y1] = points[i + 1] ?? [b, 0];
    const fine = [0.25, 0.5, 0.75].some((t) => relError(x0, y0, x1, y1, split(x0, x1, t)) > relTol);
    if (fine && x1 - x0 > 1e-9 * Math.max(1, Math.abs(x1))) {
      const middle = split(x0, x1, 0.5);
      points.splice(i + 1, 0, [middle, curve(middle)]);
      if (points.length > SOLVER_TABLE_MAX_POINTS) return null;
    } else {
      i += 1;
    }
  }
  let maxRelError = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i] ?? [a, 0];
    const [x1, y1] = points[i + 1] ?? [b, 0];
    for (let k = 1; k < 10; k += 1) maxRelError = Math.max(maxRelError, relError(x0, y0, x1, y1, x0 + ((x1 - x0) * k) / 10));
  }
  return { points, maxRelError };
}
