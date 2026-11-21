/**
 * Bounds check of linearCoefficient forms (PHY-15 TR-EOP-11): a linear law is monotonic, so on each sub-range where it applies its
 * extremes are at the sub-range ends. The check walks piecewise segments (each over its own part of the equation range) and evaluates
 * any other form that holds a linear law (product, ratioOf ratio) at those ends: the value must stay > 0 for a positive catalogue property
 * (a negative rho(T) is not a resistivity) and inside the catalogue range. Used by `modelProblem` (define, library import, load).
 */

import { convertValue, isUnitFailure } from '../lib/quantity';
import type { PropertyCatalogEntry } from './propertyCatalog';
import { evaluateForm, isFormFailure } from './propertyForms';
import type { PropertyForm, PropertyModel, PropertyVariable } from './propertyModel';

interface Problem {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

const holdsLinear = (form: PropertyForm): boolean => {
  switch (form.kind) {
    case 'linearCoefficient':
      return true;
    case 'piecewise':
      return form.segments.some((segment) => holdsLinear(segment.form));
    case 'product':
      return form.factors.some(holdsLinear);
    case 'ratioOf':
      return holdsLinear(form.ratio);
    default:
      return false;
  }
};

interface Sample {
  readonly x: number;
  readonly value: number;
  readonly path: string;
}

/** Values of `form` at the ends of [low, high] (per piecewise segment); a ratioOf is sampled through its ratio (the base model is positive on its own). */
function samples(form: PropertyForm, variable: PropertyVariable, low: number, high: number, path: string): Sample[] {
  if (!holdsLinear(form) || !(low <= high)) return [];
  if (form.kind === 'piecewise' && form.variable === variable) {
    let from = Number.NEGATIVE_INFINITY;
    return form.segments.flatMap((segment, index) => {
      const start = Math.max(low, from);
      const end = Math.min(high, segment.upTo);
      from = segment.upTo;
      return samples(segment.form, variable, start, end, `${path}.segments[${index}].form`);
    });
  }
  const target = form.kind === 'ratioOf' ? form.ratio : form;
  return [low, high].flatMap((x) => {
    const result = evaluateForm(target, { [variable]: x });
    return isFormFailure(result) ? [] : [{ x, value: result.value, path }];
  });
}

/** First linear-law value <= 0 (positive property) or outside the catalogue range over the equation range, or null. */
export function linearBoundsProblem(model: PropertyModel, entry: Pick<PropertyCatalogEntry, 'positive' | 'range'>): Problem | null {
  if (!holdsLinear(model.form) || model.variables.length !== 1) return null;
  const spec = model.variables[0];
  const range = model.validity.find((r) => r.variable === spec?.variable);
  if (spec === undefined || range === undefined) return null;
  const [low, high] = (range.equation ?? range.data).map((bound) => {
    const converted = convertValue(bound, range.unit, spec.unit);
    return isUnitFailure(converted) ? bound : converted.value;
  });
  for (const { x, value, path } of samples(model.form, spec.variable, low ?? Number.NaN, high ?? Number.NaN, 'model.form')) {
    const at = `${model.property} = ${value} at ${spec.variable} = ${x} ${spec.unit}`;
    if (entry.positive && !(value > 0))
      return { code: 'PROP_NONPOSITIVE_IN_RANGE', path, message: `${at}: it must stay > 0 over the valid range` };
    if (entry.range !== undefined && (value < entry.range.min || value > entry.range.max))
      return { code: 'EOP_PROPERTY_RANGE', path, message: `${at} is outside [${entry.range.min}, ${entry.range.max}]` };
  }
  return null;
}
