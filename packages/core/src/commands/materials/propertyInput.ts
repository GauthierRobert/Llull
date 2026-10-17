/**
 * Adapter of the 08 MAT `PropertyValue` input (value + unit + basis + source + direction / thickness / e/D / temperature) to a PHY-01
 * `PropertyModel` (TR-PROP-07): a constant, a temperature table (`table1d` over T) or a percent-of-room-temperature `ratioOf`.
 */

import { convertValue, isUnitFailure, parseUnit, sameDimension } from '../../lib/quantity';
import { catalogEntry } from '../../model/propertyCatalog';
import type {
  Basis,
  PropertyCondition,
  PropertyDirection,
  PropertyForm,
  PropertyModel,
  Provenance,
  ValidRange,
} from '../../model/propertyModel';
import { formHash } from '../document/propertyModels';
import { dependsOnTemperature, valueKey } from './propertyKey';

export interface TemperatureInput {
  readonly mode: 'absolute' | 'percentOfRT';
  readonly temperatureUnit: 'degF' | 'degC' | 'K';
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly exposureHours?: number | undefined;
  readonly rtModelId?: string | undefined;
}

export interface PropertyInput {
  readonly property: string;
  readonly value?: number | undefined;
  readonly unit: string;
  readonly basis?: Basis | undefined;
  readonly direction?: PropertyDirection | 'isotropic' | undefined;
  readonly thickness?: { readonly min: number; readonly max: number; readonly unit: string } | undefined;
  readonly edOverD?: number | undefined;
  readonly temperature?: TemperatureInput | undefined;
  readonly source?: { readonly [K in keyof Provenance]?: string | undefined } | undefined;
  readonly preferred?: boolean | undefined;
  readonly id?: string | undefined;
}

export interface InputProblem {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const problem = (code: string, path: string, message: string): InputProblem => ({ code, path, message });

/** First problem of the unit / basis / source of an input, in the order an agent should fix them. */
export function inputProblem(input: PropertyInput): InputProblem | null {
  const entry = catalogEntry(input.property);
  if (entry === undefined) return problem('PROP_PROPERTY_UNKNOWN', 'property', `'${input.property}' is not in the property catalogue`);
  const unit = parseUnit(input.unit);
  if (isUnitFailure(unit)) return problem(unit.code, 'unit', unit.message);
  const canonical = parseUnit(entry.canonicalUnit);
  if (!isUnitFailure(canonical) && !sameDimension(unit.dimension, canonical.dimension))
    return problem('MAT_UNIT_DIMENSION', 'unit', `${input.property} needs a unit like '${entry.canonicalUnit}', got '${input.unit}'`);
  if (input.basis === undefined && entry.strength && input.temperature?.mode !== 'percentOfRT')
    return problem('MAT_BASIS_MISSING', 'basis', `${input.property} is a strength allowable and needs a basis`);
  if (input.source === undefined || (input.source.citation ?? '').trim() === '')
    return problem('MAT_PROVENANCE_MISSING', 'source', `${input.property} has no source`);
  if (input.thickness !== undefined) {
    const length = convertValue(1, input.thickness.unit, 'm');
    if (isUnitFailure(length)) return problem(length.code, 'thickness.unit', length.message);
    if (!(input.thickness.min >= 0 && input.thickness.min <= input.thickness.max))
      return problem('PROP_RANGE_INVALID', 'thickness', 'need 0 <= min <= max');
  }
  if (input.edOverD !== undefined && !(input.edOverD > 0)) return problem('PROP_FORM_INVALID', 'edOverD', 'e/D must be > 0');
  return null;
}

/** Condition of the value: thickness range, e/D and exposure time. */
export function conditionOf(input: PropertyInput): PropertyCondition | undefined {
  const condition: PropertyCondition = {
    ...(input.thickness !== undefined ? { thickness: input.thickness } : {}),
    ...(input.edOverD !== undefined ? { edOverD: input.edOverD } : {}),
    ...(input.temperature?.exposureHours !== undefined ? { exposureHours: input.temperature.exposureHours } : {}),
  };
  return Object.keys(condition).length > 0 ? condition : undefined;
}

const roundTrip = (value: number): string => String(value).replace('.', 'p').replace('-', 'm');

/** Deterministic model id from the key fields; `taken` ids get a numeric suffix. */
export function modelIdFor(input: PropertyInput, taken: ReadonlySet<string>): string {
  if (input.id !== undefined) return input.id;
  const parts = [
    input.property,
    ...(input.direction !== undefined && input.direction !== 'isotropic' ? [input.direction] : []),
    input.basis ?? 'unspecified',
    ...(input.thickness !== undefined ? [`t${roundTrip(input.thickness.min)}-${roundTrip(input.thickness.max)}`] : []),
    ...(input.edOverD !== undefined ? [`ed${roundTrip(input.edOverD)}`] : []),
    ...(input.temperature !== undefined ? [input.temperature.mode === 'percentOfRT' ? 'Tpct' : 'T'] : []),
  ];
  const base = parts.join('.');
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
}

const sameKeyAsBase = (base: PropertyModel, input: PropertyInput): boolean =>
  base.property === input.property &&
  base.basis === (input.basis ?? base.basis) &&
  base.direction === (input.direction === 'isotropic' ? undefined : (input.direction ?? base.direction)) &&
  !dependsOnTemperature(base) &&
  base.form.kind === 'constant';

/** The room-temperature model a percent-of-RT table scales: `rtModelId`, else the only constant model of the same key. */
export function roomTemperatureBase(
  models: readonly PropertyModel[],
  input: PropertyInput,
  condition: PropertyCondition | undefined,
): PropertyModel | InputProblem {
  const wanted = input.temperature?.rtModelId;
  if (wanted !== undefined) {
    const found = models.find((model) => model.id === wanted);
    return found ?? problem('PROP_MODEL_NOT_FOUND', 'temperature.rtModelId', `no model '${wanted}' on the material`);
  }
  const candidates = models.filter(
    (model) =>
      sameKeyAsBase(model, input) && JSON.stringify(model.condition ?? null) === JSON.stringify(withoutExposure(condition) ?? null),
  );
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;
  return problem(
    candidates.length === 0 ? 'PROP_MODEL_NOT_FOUND' : 'MAT_ALLOWABLE_AMBIGUOUS',
    'temperature',
    candidates.length === 0
      ? `percentOfRT needs the room-temperature ${input.property} value first (a constant model on the same basis, direction, thickness and e/D)`
      : `${candidates.length} room-temperature ${input.property} values match; name one with temperature.rtModelId`,
  );
}

function withoutExposure(condition: PropertyCondition | undefined): PropertyCondition | undefined {
  if (condition === undefined) return undefined;
  const { exposureHours: _hours, ...rest } = condition;
  void _hours;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The PHY-01 model of `input` (already passed `inputProblem`); `base` is required for percentOfRT. */
export function modelOf(input: PropertyInput, id: string, base?: PropertyModel): PropertyModel | InputProblem {
  let provenance = JSON.parse(JSON.stringify(input.source ?? {})) as Provenance;
  const temperature = input.temperature;
  const condition = conditionOf(input);
  let form: PropertyForm;
  let variables: PropertyModel['variables'] = [];
  let validity: readonly ValidRange[] = [];
  let unit = input.unit;
  let basis: Basis = input.basis ?? 'unspecified';
  let direction: PropertyDirection | undefined = input.direction === 'isotropic' ? undefined : input.direction;
  let inherited: PropertyCondition | undefined = condition;
  if (temperature === undefined) {
    if (input.value === undefined || !Number.isFinite(input.value))
      return problem('PROP_FORM_INVALID', 'value', 'give the value (a finite number)');
    form = { kind: 'constant', value: input.value };
  } else {
    if (input.value !== undefined)
      return problem('PROP_FORM_INVALID', 'value', 'omit value when a temperature table is given (the points carry the values)');
    const xs = temperature.points.map(([t]) => t);
    const first = xs[0];
    const last = xs[xs.length - 1];
    if (first === undefined || last === undefined || xs.length < 2)
      return problem('PROP_FORM_INVALID', 'temperature.points', 'need at least 2 [T, value] points');
    variables = [{ variable: 'T', unit: temperature.temperatureUnit }];
    validity = [{ variable: 'T', unit: temperature.temperatureUnit, data: [first, last] }];
    if (temperature.mode === 'absolute') {
      form = { kind: 'table1d', variable: 'T', points: temperature.points, interpolation: 'linear' };
    } else {
      if (base === undefined) return problem('PROP_MODEL_NOT_FOUND', 'temperature', 'percentOfRT needs the room-temperature model');
      form = {
        kind: 'ratioOf',
        baseModelId: base.id,
        ratio: {
          kind: 'table1d',
          variable: 'T',
          points: temperature.points.map(([t, percent]) => [t, percent / 100] as const),
          interpolation: 'linear',
        },
      };
      unit = base.unit;
      basis = base.basis;
      direction = base.direction;
      inherited = { ...base.condition, ...(temperature.exposureHours !== undefined ? { exposureHours: temperature.exposureHours } : {}) };
      const note = [
        provenance.note,
        `percent of the room-temperature value of model '${base.id}' (${base.provenance.citation ?? base.provenance.sourceId ?? 'no source'})`,
      ]
        .filter((part) => part !== undefined)
        .join('; ');
      provenance = { ...provenance, note };
    }
  }
  return {
    id,
    property: input.property,
    unit,
    variables,
    form,
    validity,
    basis,
    ...(direction !== undefined ? { direction } : {}),
    ...(inherited !== undefined && Object.keys(inherited).length > 0 ? { condition: inherited } : {}),
    provenance,
    coefficientsSha256: formHash(form),
    ...(input.preferred === true ? { preferred: true as const } : {}),
  };
}

/** Models of the material that compete with `model` for `preferred` (same key, other id). */
export const rivalsOf = (models: readonly PropertyModel[], model: PropertyModel): PropertyModel[] =>
  models.filter((other) => other.id !== model.id && other.preferred === true && valueKey(other) === valueKey(model));
