/**
 * Normative evaluation of a property form (PHY-01 TECHNICAL_SPEC §5.1–§5.2): value and optional derivative with respect to one variable,
 * at variable values already converted to the model's units. Pure; no range guard here (propertyModelEval does it first).
 */

import type { PropertyForm, PropertyVariable } from './propertyModel';

/** R = N_A · k_B, exact since the 2019 SI redefinition. */
export const GAS_CONSTANT = 6.02214076e23 * 1.380649e-23;

export type Point = Readonly<Partial<Record<PropertyVariable, number>>>;

interface FormValue {
  readonly value: number;
  readonly derivative?: number;
}

export interface FormFailure {
  readonly code: 'PROP_VARIABLE_MISSING' | 'PROP_DERIVATIVE_UNAVAILABLE' | 'PROP_OUT_OF_RANGE' | 'PROP_MODEL_NOT_FOUND';
  readonly message: string;
}

export type FormResult = FormValue | FormFailure;

/** Evaluates a `ratioOf` base model at the same point (resolved by the caller). */
export type BaseEvaluator = (baseModelId: string, at: Point, wrt: PropertyVariable | undefined) => FormResult;

export const isFormFailure = (result: FormResult): result is FormFailure => 'code' in result;

const missing = (variable: string): FormFailure => ({ code: 'PROP_VARIABLE_MISSING', message: `variable ${variable} is required` });

const polynomialAt = (coefficients: readonly number[], u: number): { value: number; slope: number } => {
  let value = 0;
  let slope = 0;
  for (let k = coefficients.length - 1; k >= 0; k -= 1) {
    slope = slope * u + value;
    value = value * u + (coefficients[k] ?? 0);
  }
  return { value, slope };
};

const withDerivative = (value: number, derivative: number, wanted: boolean): FormValue => (wanted ? { value, derivative } : { value });

function table1d(form: Extract<PropertyForm, { kind: 'table1d' }>, x: number, wanted: boolean): FormResult {
  const { points, interpolation } = form;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || x < first[0] || x > last[0]) {
    return { code: 'PROP_OUT_OF_RANGE', message: `${form.variable} = ${x} is outside the table [${first?.[0]}, ${last?.[0]}]` };
  }
  let index = 0;
  while (index < points.length - 2 && x >= (points[index + 1]?.[0] ?? Number.POSITIVE_INFINITY)) index += 1;
  const [x0, y0] = points[index] ?? first;
  const [x1, y1] = points[index + 1] ?? last;
  if (interpolation === 'step') {
    if (wanted) return { code: 'PROP_DERIVATIVE_UNAVAILABLE', message: 'a step table has no derivative' };
    return { value: x >= x1 ? y1 : y0 };
  }
  if (interpolation === 'linear') {
    const slope = (y1 - y0) / (x1 - x0);
    return withDerivative(y0 + slope * (x - x0), slope, wanted);
  }
  const lnRatio = Math.log(y1) - Math.log(y0);
  if (interpolation === 'loglinear') {
    const value = Math.exp(Math.log(y0) + (lnRatio * (x - x0)) / (x1 - x0));
    return withDerivative(value, (value * lnRatio) / (x1 - x0), wanted);
  }
  const span = Math.log(x1) - Math.log(x0);
  const value = Math.exp(Math.log(y0) + (lnRatio * (Math.log(x) - Math.log(x0))) / span);
  return withDerivative(value, (value * lnRatio) / span / x, wanted);
}

function table2d(form: Extract<PropertyForm, { kind: 'table2d' }>, at: Point, wrt: PropertyVariable | undefined): FormResult {
  const rawX = at[form.x.variable];
  const rawY = at[form.y.variable];
  if (rawX === undefined) return missing(form.x.variable);
  if (rawY === undefined) return missing(form.y.variable);
  const axis = (values: readonly number[], raw: number, log: boolean): { i: number; t: number; dt: number } | null => {
    const v = log ? Math.log10(raw) : raw;
    const grid = log ? values.map(Math.log10) : values;
    const firstValue = grid[0] ?? Number.NaN;
    const lastValue = grid[grid.length - 1] ?? Number.NaN;
    if (!(v >= firstValue && v <= lastValue)) return null;
    let i = 0;
    while (i < grid.length - 2 && v >= (grid[i + 1] ?? Number.POSITIVE_INFINITY)) i += 1;
    const g0 = grid[i] ?? 0;
    const width = (grid[i + 1] ?? 0) - g0;
    return { i, t: (v - g0) / width, dt: (log ? 1 / (raw * Math.LN10) : 1) / width };
  };
  const ax = axis(form.xs, rawX, form.x.axis === 'log10');
  const ay = axis(form.ys, rawY, form.y.axis === 'log10');
  if (ax === null || ay === null) return { code: 'PROP_OUT_OF_RANGE', message: 'point outside the table2d grid' };
  const v = (i: number, j: number): number => form.values[i]?.[j] ?? Number.NaN;
  const [v00, v01, v10, v11] = [v(ax.i, ay.i), v(ax.i, ay.i + 1), v(ax.i + 1, ay.i), v(ax.i + 1, ay.i + 1)];
  const { t: u, dt: du } = ax;
  const { t: w, dt: dw } = ay;
  const value = (1 - u) * (1 - w) * v00 + (1 - u) * w * v01 + u * (1 - w) * v10 + u * w * v11;
  if (wrt === undefined) return { value };
  if (wrt === form.x.variable) return { value, derivative: ((1 - w) * (v10 - v00) + w * (v11 - v01)) * du };
  if (wrt === form.y.variable) return { value, derivative: ((1 - u) * (v01 - v00) + u * (v11 - v10)) * dw };
  return { value, derivative: 0 };
}

/** Value (and d/d`wrt` when asked) of `form` at `at`. A variable the form does not read has derivative 0. */
export function evaluateForm(form: PropertyForm, at: Point, wrt?: PropertyVariable, base?: BaseEvaluator): FormResult {
  const read = (variable: PropertyVariable): number | undefined => at[variable];
  const wantsFor = (variable: PropertyVariable): boolean => wrt === variable;
  switch (form.kind) {
    case 'constant':
      return withDerivative(form.value, 0, wrt !== undefined);
    case 'table1d': {
      const x = read(form.variable);
      if (x === undefined) return missing(form.variable);
      const result = table1d(form, x, wantsFor(form.variable));
      return isFormFailure(result) || wrt === undefined || wantsFor(form.variable) ? result : { value: result.value, derivative: 0 };
    }
    case 'table2d':
      return table2d(form, at, wrt);
    case 'polynomial': {
      const x = read(form.variable);
      if (x === undefined) return missing(form.variable);
      const { value, slope } = polynomialAt(form.coefficients, x - (form.origin ?? 0));
      return withDerivative(value, wantsFor(form.variable) ? slope : 0, wrt !== undefined);
    }
    case 'log10Polynomial': {
      const x = read(form.variable);
      if (x === undefined) return missing(form.variable);
      const { value: exponent, slope } = polynomialAt(form.coefficients, Math.log10(x));
      const value = 10 ** exponent;
      return withDerivative(value, wantsFor(form.variable) ? (value * slope) / x : 0, wrt !== undefined);
    }
    case 'nistRational': {
      const t = read('T');
      if (t === undefined) return missing('T');
      const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = form.coefficients;
      const s = Math.sqrt(t);
      const numerator = a + c * s + e * t + g * t * s + i * t * t;
      const denominator = 1 + b * s + d * t + f * t * s + h * t * t;
      const value = 10 ** (numerator / denominator);
      const dN = c / (2 * s) + e + 1.5 * g * s + 2 * i * t;
      const dD = b / (2 * s) + d + 1.5 * f * s + 2 * h * t;
      return withDerivative(
        value,
        wantsFor('T') ? (value * Math.LN10 * (dN * denominator - numerator * dD)) / denominator ** 2 : 0,
        wrt !== undefined,
      );
    }
    case 'arrhenius': {
      const t = read('T');
      if (t === undefined) return missing('T');
      const m = form.temperatureExponent ?? 0;
      const q = form.activationEnergyJPerMol;
      const value = form.preFactor * t ** m * Math.exp(-q / (GAS_CONSTANT * t));
      return withDerivative(value, wantsFor('T') ? value * (m / t + q / (GAS_CONSTANT * t * t)) : 0, wrt !== undefined);
    }
    case 'powerLaw': {
      const x = read(form.variable);
      if (x === undefined) return missing(form.variable);
      const value = form.coefficient * (x / form.reference) ** form.exponent;
      return withDerivative(value, wantsFor(form.variable) ? (form.exponent * value) / x : 0, wrt !== undefined);
    }
    case 'piecewise': {
      const x = read(form.variable);
      if (x === undefined) return missing(form.variable);
      const segment = form.segments.find((s) => x <= s.upTo);
      if (segment === undefined) return { code: 'PROP_OUT_OF_RANGE', message: `${form.variable} = ${x} is above the last segment` };
      return evaluateForm(segment.form, at, wrt, base);
    }
    case 'rateFactor': {
      const rate = read('strainRate');
      if (rate === undefined) return missing('strainRate');
      if (form.law === 'johnsonCook') {
        if (rate < form.referenceRate) return withDerivative(1, 0, wrt !== undefined);
        return withDerivative(
          1 + form.C * Math.log(rate / form.referenceRate),
          wantsFor('strainRate') ? form.C / rate : 0,
          wrt !== undefined,
        );
      }
      const term = (rate / form.D) ** (1 / form.q);
      return withDerivative(1 + term, wantsFor('strainRate') ? term / form.q / rate : 0, wrt !== undefined);
    }
    case 'product':
      return productOf(
        form.factors.map((factor) => evaluateForm(factor, at, wrt, base)),
        wrt !== undefined,
      );
    case 'ratioOf': {
      if (base === undefined) return { code: 'PROP_MODEL_NOT_FOUND', message: `base model ${form.baseModelId} is not available` };
      return productOf([base(form.baseModelId, at, wrt), evaluateForm(form.ratio, at, wrt, base)], wrt !== undefined);
    }
  }
}

function productOf(parts: readonly FormResult[], wanted: boolean): FormResult {
  let value = 1;
  let derivative = 0;
  for (const part of parts) {
    if (isFormFailure(part)) return part;
    derivative = derivative * part.value + value * (part.derivative ?? 0);
    value *= part.value;
  }
  return withDerivative(value, derivative, wanted);
}
