/**
 * Well-formedness of a property model (PHY-01 TECHNICAL_SPEC §3.4): form shape, strictly increasing tables, every variable listed with a
 * range (data ⊆ equation), units of the right dimension, provenance present. Shared by `define_property_model` and document loading.
 */

import { convertValue, isUnitFailure, parseUnit, sameDimension } from '../lib/quantity';
import { catalogEntry } from './propertyCatalog';
import { formVariables, type PropertyForm, type PropertyModel } from './propertyModel';

export interface ModelProblem {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

const problem = (code: string, path: string, message: string): ModelProblem => ({ code, path, message });

const finite = (values: readonly number[]): boolean => values.every(Number.isFinite);

const increasing = (values: readonly number[]): number => values.findIndex((v, i) => i > 0 && !(v > (values[i - 1] ?? Number.NaN)));

type FormOf<K extends PropertyForm['kind']> = Extract<PropertyForm, { kind: K }>;

const formInvalid = (path: string, field: string, message: string): ModelProblem =>
  problem('PROP_FORM_INVALID', `${path}.${field}`, message);

function polynomialProblem(form: FormOf<'polynomial' | 'log10Polynomial'>, path: string): ModelProblem | null {
  if (form.coefficients.length === 0 || !finite(form.coefficients))
    return formInvalid(path, 'coefficients', 'need at least one finite coefficient');
  if (form.kind === 'log10Polynomial' && form.coefficients.length > 9)
    return formInvalid(path, 'coefficients', 'a log10Polynomial has at most 9 coefficients (a…i)');
  return null;
}

function table1dProblem(form: FormOf<'table1d'>, path: string): ModelProblem | null {
  if (form.points.length < 2) return formInvalid(path, 'points', 'a table needs at least 2 points');
  const xs = form.points.map(([x]) => x);
  const ys = form.points.map(([, y]) => y);
  if (!finite(xs) || !finite(ys)) return formInvalid(path, 'points', 'points must be finite');
  const bad = increasing(xs);
  if (bad >= 0) return problem('PROP_TABLE_NOT_MONOTONIC', `${path}.points[${bad}]`, 'x must be strictly increasing');
  if (form.interpolation === 'loglog' || form.interpolation === 'loglinear') {
    const nonPositive = ys.findIndex((y) => y <= 0);
    if (nonPositive >= 0) return problem('PROP_TABLE_NOT_MONOTONIC', `${path}.points[${nonPositive}]`, `${form.interpolation} needs y > 0`);
  }
  if (form.interpolation === 'loglog' && (xs[0] ?? 0) <= 0)
    return problem('PROP_TABLE_NOT_MONOTONIC', `${path}.points[0]`, 'loglog needs x > 0');
  return null;
}

function table2dProblem(form: FormOf<'table2d'>, path: string): ModelProblem | null {
  for (const [axis, values] of [
    ['xs', form.xs],
    ['ys', form.ys],
  ] as const) {
    if (values.length < 2 || !finite(values)) return formInvalid(path, axis, 'each axis needs at least 2 finite values');
    const bad = increasing(values);
    if (bad >= 0) return problem('PROP_TABLE_NOT_MONOTONIC', `${path}.${axis}[${bad}]`, 'axis must be strictly increasing');
    const spec = axis === 'xs' ? form.x : form.y;
    if (spec.axis === 'log10' && (values[0] ?? 0) <= 0)
      return problem('PROP_TABLE_NOT_MONOTONIC', `${path}.${axis}[0]`, 'a log10 axis needs values > 0');
  }
  const shaped = form.values.length === form.xs.length && form.values.every((row) => row.length === form.ys.length && finite(row));
  return shaped ? null : formInvalid(path, 'values', 'values[i][j] must be finite, one row per xs value, one column per ys value');
}

function piecewiseProblem(form: FormOf<'piecewise'>, path: string, knownModelIds: ReadonlySet<string>): ModelProblem | null {
  if (form.segments.length === 0) return formInvalid(path, 'segments', 'need at least one segment');
  const bad = increasing(form.segments.map((segment) => segment.upTo));
  if (bad >= 0) return problem('PROP_TABLE_NOT_MONOTONIC', `${path}.segments[${bad}].upTo`, 'upTo must be strictly increasing');
  for (const [i, segment] of form.segments.entries()) {
    const nested = formProblem(segment.form, `${path}.segments[${i}].form`, knownModelIds);
    if (nested !== null) return nested;
  }
  return null;
}

function productProblem(form: FormOf<'product'>, path: string, knownModelIds: ReadonlySet<string>): ModelProblem | null {
  if (form.factors.length === 0) return formInvalid(path, 'factors', 'need at least one factor');
  for (const [i, factor] of form.factors.entries()) {
    const nested = formProblem(factor, `${path}.factors[${i}]`, knownModelIds);
    if (nested !== null) return nested;
  }
  return null;
}

/** First problem of a form (recursive), or null. `knownModelIds` resolves `ratioOf` bases. */
function formProblem(form: PropertyForm, path: string, knownModelIds: ReadonlySet<string>): ModelProblem | null {
  const invalid = (field: string, message: string): ModelProblem => formInvalid(path, field, message);
  switch (form.kind) {
    case 'constant':
      return Number.isFinite(form.value) ? null : invalid('value', 'must be finite');
    case 'polynomial':
    case 'log10Polynomial':
      return polynomialProblem(form, path);
    case 'nistRational':
      return form.coefficients.length === 9 && finite(form.coefficients)
        ? null
        : invalid('coefficients', 'a nistRational form needs exactly 9 coefficients a…i');
    case 'arrhenius':
      return Number.isFinite(form.preFactor) && Number.isFinite(form.activationEnergyJPerMol)
        ? null
        : invalid('preFactor', 'must be finite');
    case 'linearCoefficient':
      return finite([form.referenceValue, form.coefficient, form.reference])
        ? null
        : invalid('coefficient', 'referenceValue, coefficient and reference must be finite');
    case 'powerLaw':
      return form.reference > 0 && finite([form.coefficient, form.exponent]) ? null : invalid('reference', 'reference must be > 0');
    case 'rateFactor':
      if (form.law === 'johnsonCook')
        return form.referenceRate > 0 && Number.isFinite(form.C) ? null : invalid('referenceRate', 'must be > 0');
      return form.D > 0 && form.q > 0 ? null : invalid('D', 'D and q must be > 0');
    case 'table1d':
      return table1dProblem(form, path);
    case 'table2d':
      return table2dProblem(form, path);
    case 'piecewise':
      return piecewiseProblem(form, path, knownModelIds);
    case 'product':
      return productProblem(form, path, knownModelIds);
    case 'ratioOf':
      if (!knownModelIds.has(form.baseModelId))
        return invalid('baseModelId', `base model '${form.baseModelId}' is not defined on this material`);
      return formProblem(form.ratio, `${path}.ratio`, knownModelIds);
  }
}

/** The first constant / table value of a form outside `[min, max]` (nested piecewise segments included), or null. */
function rangeProblem(
  form: PropertyForm,
  path: string,
  range: { readonly min: number; readonly max: number },
  property: string,
): ModelProblem | null {
  const outside = (value: number): boolean => value < range.min || value > range.max;
  const bad = (where: string, value: number): ModelProblem =>
    problem('EOP_PROPERTY_RANGE', `${path}.${where}`, `${property} must be within [${range.min}, ${range.max}], got ${value}`);
  if (form.kind === 'constant') return outside(form.value) ? bad('value', form.value) : null;
  if (form.kind === 'table1d') {
    const index = form.points.findIndex(([, y]) => outside(y));
    return index >= 0 ? bad(`points[${index}]`, form.points[index]?.[1] ?? Number.NaN) : null;
  }
  if (form.kind === 'piecewise') {
    for (const [i, segment] of form.segments.entries()) {
      const nested = rangeProblem(segment.form, `${path}.segments[${i}].form`, range, property);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** First problem of a whole model, or null. `otherModelIds` = the other models already on the material. */
export function modelProblem(model: PropertyModel, otherModelIds: ReadonlySet<string>): ModelProblem | null {
  const entry = catalogEntry(model.property);
  if (entry === undefined)
    return problem('PROP_PROPERTY_UNKNOWN', 'model.property', `'${model.property}' is not in the property catalogue`);
  const output = parseUnit(model.unit);
  if (isUnitFailure(output)) return problem(output.code, 'model.unit', output.message);
  const canonical = parseUnit(entry.canonicalUnit);
  if (!isUnitFailure(canonical) && !sameDimension(output.dimension, canonical.dimension)) {
    return problem('MAT_UNIT_DIMENSION', 'model.unit', `${model.property} needs a unit like '${entry.canonicalUnit}', got '${model.unit}'`);
  }
  if (model.provenance.citation === undefined && model.provenance.sourceId === undefined) {
    return problem('MAT_PROVENANCE_MISSING', 'model.source', 'give source.citation (and locator / url / accessed)');
  }
  const formIssue = formProblem(model.form, 'model.form', otherModelIds);
  if (formIssue !== null) return formIssue;
  if (entry.range !== undefined) {
    const outside = rangeProblem(model.form, 'model.form', entry.range, model.property);
    if (outside !== null) return outside;
  }
  for (const [i, spec] of model.variables.entries()) {
    const unit = parseUnit(spec.unit);
    if (isUnitFailure(unit)) return problem(unit.code, `model.variables[${i}].unit`, unit.message);
    if (spec.variable === 'T' && unit.offset !== 0 && needsAbsoluteTemperature(model.form)) {
      return problem(
        'MAT_UNIT_DIMENSION',
        `model.variables[${i}].unit`,
        `a ${model.form.kind} form needs an absolute temperature (K or degR), got '${spec.unit}'`,
      );
    }
  }
  for (const variable of formVariables(model.form)) {
    if (!model.variables.some((spec) => spec.variable === variable)) {
      return problem('PROP_FORM_INVALID', 'model.variables', `the form reads ${variable}: list it in variables with its unit`);
    }
  }
  for (const spec of model.variables) {
    const index = model.validity.findIndex((range) => range.variable === spec.variable);
    const range = model.validity[index];
    if (range === undefined) return problem('PROP_RANGE_INVALID', 'model.validity', `variable ${spec.variable} needs a validity range`);
    if (isUnitFailure(convertValue(1, range.unit, spec.unit))) {
      return problem(
        'MAT_UNIT_DIMENSION',
        `model.validity[${index}].unit`,
        `range unit '${range.unit}' does not match variable ${spec.variable} ('${spec.unit}')`,
      );
    }
    const [low, high] = range.data;
    const equation = range.equation ?? range.data;
    if (!(low < high) || !(equation[0] < equation[1]) || equation[0] > low || equation[1] < high) {
      return problem('PROP_RANGE_INVALID', `model.validity[${index}]`, 'need data min < max and the equation range ⊇ the data range');
    }
  }
  const coverage = coverageProblem(model);
  if (coverage !== null) return coverage;
  return linearBoundsProblem(model, entry);
}

/**
 * A top-level linearCoefficient form is monotonic, so its extremes are at the equation-range bounds: there it must stay > 0 for a positive
 * catalogue property (a negative rho(T) is not a resistivity) and inside the catalogue range.
 */
function linearBoundsProblem(
  model: PropertyModel,
  entry: { readonly positive: boolean; readonly range?: { min: number; max: number } },
): ModelProblem | null {
  const form = model.form;
  if (form.kind !== 'linearCoefficient') return null;
  const range = model.validity.find((r) => r.variable === form.variable);
  const unit = model.variables.find((v) => v.variable === form.variable)?.unit;
  if (range === undefined || unit === undefined) return null;
  for (const bound of range.equation ?? range.data) {
    const converted = convertValue(bound, range.unit, unit);
    const x = isUnitFailure(converted) ? bound : converted.value;
    const value = form.referenceValue * (1 + form.coefficient * (x - form.reference));
    if (entry.positive && !(value > 0))
      return problem(
        'PROP_NONPOSITIVE_IN_RANGE',
        'model.form',
        `${model.property} = ${value} at ${form.variable} = ${x} ${unit}: it must stay > 0 over the valid range`,
      );
    if (entry.range !== undefined && (value < entry.range.min || value > entry.range.max))
      return problem(
        'EOP_PROPERTY_RANGE',
        'model.form',
        `${model.property} = ${value} at ${form.variable} = ${x} ${unit} is outside [${entry.range.min}, ${entry.range.max}]`,
      );
  }
  return null;
}

/** Forms that read T as an absolute temperature (logarithms, powers, exp(−Q/RT)). */
function needsAbsoluteTemperature(form: PropertyForm): boolean {
  switch (form.kind) {
    case 'arrhenius':
    case 'nistRational':
      return true;
    case 'log10Polynomial':
    case 'powerLaw':
      return form.variable === 'T';
    case 'table1d':
      return form.variable === 'T' && form.interpolation === 'loglog';
    case 'piecewise':
      return form.segments.some((segment) => needsAbsoluteTemperature(segment.form));
    case 'product':
      return form.factors.some(needsAbsoluteTemperature);
    case 'ratioOf':
      return needsAbsoluteTemperature(form.ratio);
    default:
      return false;
  }
}

/** A top-level table or piecewise form must cover the whole equation range of its variable. */
function coverageProblem(model: PropertyModel): ModelProblem | null {
  const form = model.form;
  if (form.kind !== 'table1d' && form.kind !== 'piecewise') return null;
  const range = model.validity.find((r) => r.variable === form.variable);
  const unit = model.variables.find((v) => v.variable === form.variable)?.unit;
  if (range === undefined || unit === undefined) return null;
  const [low, high] = (range.equation ?? range.data).map((v) => {
    const converted = convertValue(v, range.unit, unit);
    return isUnitFailure(converted) ? v : converted.value;
  });
  const tolerance = (bound: number): number => 1e-9 * Math.max(1, Math.abs(bound));
  const first = form.kind === 'table1d' ? (form.points[0]?.[0] ?? Number.NaN) : Number.NEGATIVE_INFINITY;
  const last =
    form.kind === 'table1d'
      ? (form.points[form.points.length - 1]?.[0] ?? Number.NaN)
      : (form.segments[form.segments.length - 1]?.upTo ?? Number.NaN);
  if (low === undefined || high === undefined || first > low + tolerance(low) || last < high - tolerance(high)) {
    return problem(
      'PROP_RANGE_INVALID',
      'model.validity',
      `the ${form.kind} form covers ${form.variable} up to ${last}, not the whole valid range [${low}, ${high}] ${unit}`,
    );
  }
  return null;
}
