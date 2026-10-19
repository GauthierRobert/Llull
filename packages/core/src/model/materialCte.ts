/**
 * Thermal strain of a part between its specification temperature and an operating temperature, from (a) a document material's PHY-01
 * property models (`thermalStrain` first, else `cte` with a stated basis) or (b) an explicit secant CTE. Pure; never extrapolates.
 */

import { convertValue, isUnitFailure } from '../lib/quantity';
import { sampledIntegral, tableLaw, type Alpha } from './cteConversion';
import {
  evaluatePropertyModel,
  isRefused,
  resolvePropertyModel,
  type PropertyEvaluation,
  type PropertyEvaluationRefused,
  type PropertyRecord,
} from './propertyModelEval';
import type { PropertyDirection, PropertyModel } from './propertyModel';
import type { Material } from './types';

export interface CteRefusal {
  readonly code: string;
  readonly reason: string;
  readonly remediation: string;
  readonly path: string;
  /** PHY-01 refusal wrapped by a TMC code. */
  readonly cause?: PropertyEvaluationRefused;
}

export interface StrainResult {
  readonly strain: number;
  readonly unverifiedReasons: readonly string[];
  /** Estimated absolute error of the strain (sampled integral only). */
  readonly samplingError?: number;
}

export type CteBasis =
  | { readonly kind: 'secant'; readonly referenceKelvin: number }
  | { readonly kind: 'instantaneous' }
  | { readonly kind: 'unstated' };

export interface CteProvider {
  readonly source: string;
  readonly basis: string;
  readonly conversion: string;
  readonly strainAt: (temperatureKelvin: number, specKelvin: number) => StrainResult | CteRefusal;
}

export const isCteRefusal = (value: StrainResult | CteRefusal | CteProvider): value is CteRefusal => 'code' in value;

const wrap = (refused: PropertyEvaluationRefused, path: string): CteRefusal =>
  refused.code === 'PROP_OUT_OF_RANGE'
    ? {
        code: 'TMC_PROPERTY_OUT_OF_RANGE',
        reason: `${refused.reason} (PHY-01 PROP_OUT_OF_RANGE, see data.cause)`,
        remediation: 'define a property model sourced for that temperature range (define_property_model); llull never extrapolates',
        path,
        cause: refused,
      }
    : { code: refused.code, reason: refused.reason, remediation: refused.remediation, path, cause: refused };

const uniq = (reasons: readonly string[]): string[] => [...new Set(reasons)];

/** Explicit constant secant CTE: strain = alpha (T - T_spec); unverified because it has no record, basis or sourced model. */
export function explicitCteProvider(alphaPerKelvin: number, referenceKelvin: number, source: string): CteProvider {
  return {
    source: `explicit secant CTE${source === '' ? '' : ` (${source})`}`,
    basis: `secant, reference ${referenceKelvin} K`,
    conversion: 'constant secant CTE: strain between two temperatures is alpha (T - T_spec) for any reference',
    strainAt: (temperature, spec) => ({
      strain: alphaPerKelvin * (temperature - spec),
      unverifiedReasons: ['explicit CTE without a sourced material record'],
    }),
  };
}

type Evaluated = Extract<PropertyEvaluation, { available: true }>;

const modelAt = (record: PropertyRecord, model: PropertyModel, kelvin: number, unit: string, path: string): Evaluated | CteRefusal => {
  const evaluation = evaluatePropertyModel(record, model, { T: { value: kelvin, unit: 'K' } }, { outputUnit: unit });
  return evaluation.available ? evaluation : wrap(evaluation, path);
};

/** The model at `kelvin` and at the reference `spec`, with their merged unverified reasons, or the first refusal. */
function endpointsAt(
  record: PropertyRecord,
  model: PropertyModel,
  kelvin: number,
  spec: number,
  unit: string,
  path: string,
): { readonly hot: Evaluated; readonly reference: Evaluated; readonly reasons: string[] } | CteRefusal {
  const hot = modelAt(record, model, kelvin, unit, path);
  if ('code' in hot) return hot;
  const reference = modelAt(record, model, spec, unit, path);
  if ('code' in reference) return reference;
  return { hot, reference, reasons: uniq([...hot.unverifiedReasons, ...reference.unverifiedReasons]) };
}

/** `thermalStrain` model: strain = (s(T) - s(T_spec)) / (1 + s(T_spec)), the exact secant of PHY-01 TECHNICAL_SPEC §3.3. */
function thermalStrainProvider(record: PropertyRecord, model: PropertyModel, path: string): CteProvider {
  return {
    source: `${record.name}/${model.id} (thermalStrain model)`,
    basis: 'thermal strain (L - L_ref)/L_ref',
    conversion: 'secant from thermalStrain: (s(T) - s(T_spec)) / ((T - T_spec)(1 + s(T_spec)))',
    strainAt: (temperature, spec) => {
      const ends = endpointsAt(record, model, temperature, spec, '1', path);
      if ('code' in ends) return ends;
      const { hot, reference, reasons } = ends;
      return { strain: (hot.value - reference.value) / (1 + reference.value), unverifiedReasons: reasons };
    },
  };
}

/** `cte` model with a stated basis: secant re-referenced to T_spec, or instantaneous integrated (exact table / Simpson <= 10 K). */
function cteModelProvider(record: PropertyRecord, model: PropertyModel, basis: CteBasis, path: string): CteProvider {
  const source = `${record.name}/${model.id} (cte model)`;
  if (basis.kind === 'secant') {
    return {
      source,
      basis: `secant, reference ${basis.referenceKelvin} K`,
      conversion: `re-referenced from ${basis.referenceKelvin} K to T_spec: [a(T)(T - Ta) - a(Ts)(Ts - Ta)] / (T - Ts)`,
      strainAt: (temperature, spec) => {
        const ends = endpointsAt(record, model, temperature, spec, '1/K', path);
        if ('code' in ends) return ends;
        const { hot, reference, reasons } = ends;
        const strain = hot.value * (temperature - basis.referenceKelvin) - reference.value * (spec - basis.referenceKelvin);
        return { strain, unverifiedReasons: reasons };
      },
    };
  }
  const unit = model.variables.find((spec) => spec.variable === 'T')?.unit;
  const unitScale = convertValue(1, model.unit, '1/K');
  const form = model.form;
  const exact =
    form.kind === 'table1d' && form.interpolation === 'linear' && form.variable === 'T' && unit === 'K' && !isUnitFailure(unitScale)
      ? tableLaw(form.points.map(([t, a]) => [t, a * unitScale.value] as const))
      : undefined;
  return {
    source,
    basis: 'instantaneous',
    conversion:
      exact !== undefined
        ? 'instantaneous table integrated exactly (piecewise linear)'
        : 'instantaneous model sampled at <= 10 K steps, Simpson',
    strainAt: (temperature, spec) => {
      const ends = endpointsAt(record, model, temperature, spec, '1/K', path);
      if ('code' in ends) return ends;
      const { reasons } = ends;
      if (exact !== undefined) {
        const strain = exact.integral(spec, temperature);
        if (Number.isFinite(strain)) return { strain, unverifiedReasons: reasons };
      }
      let refused: CteRefusal | undefined;
      const alpha: Alpha = (t) => {
        const point = modelAt(record, model, t, '1/K', path);
        if ('code' in point) {
          refused ??= point;
          return Number.NaN;
        }
        return point.value;
      };
      const integral = sampledIntegral(alpha, spec, temperature);
      if (refused !== undefined) return refused;
      return { strain: integral.value, unverifiedReasons: reasons, samplingError: integral.errorEstimate };
    },
  };
}

/**
 * Provider for one material of the document.
 * @failure MAT_RECORD_NOT_FOUND; TMC_MATERIAL_NO_CTE (no thermalStrain / cte model); TMC_CTE_BASIS_UNKNOWN (cte model, basis unstated);
 *   PHY-01 ambiguity codes (several unpreferred models)
 * @param direction material direction of an orthotropic CTE (models with that `direction` only); absent = the models of any direction
 */
export function materialCteProvider(
  materials: Readonly<Record<string, Material>>,
  name: string,
  basis: CteBasis,
  path: string,
  direction?: PropertyDirection,
): CteProvider | CteRefusal {
  const material = Object.hasOwn(materials, name) ? materials[name] : undefined;
  if (material === undefined) {
    return { code: 'MAT_RECORD_NOT_FOUND', reason: `no material '${name}'`, remediation: 'create_material first', path };
  }
  const record: PropertyRecord = { name, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  const directed = direction === undefined ? {} : { direction };
  const strain = resolvePropertyModel(record, { property: 'thermalStrain', ...directed });
  if (!isRefused(strain)) return thermalStrainProvider(record, strain, path);
  if ((strain.candidates ?? []).length > 0) return wrap(strain, path);
  const cte = resolvePropertyModel(record, { property: 'cte', ...directed });
  if (isRefused(cte)) {
    return (cte.candidates ?? []).length > 0
      ? wrap(cte, path)
      : {
          code: 'TMC_MATERIAL_NO_CTE',
          reason: `material '${name}' has no thermalStrain or cte property model`,
          remediation: 'define_property_model with property thermalStrain (preferred) or cte on this material, or pass an explicit CTE',
          path,
        };
  }
  if (basis.kind === 'unstated') {
    return {
      code: 'TMC_CTE_BASIS_UNKNOWN',
      reason: `the cte model '${cte.id}' of '${name}' does not state whether it is secant or instantaneous`,
      remediation: `pass cteBasis.${name} = { kind: 'secant', referenceTemperature } or { kind: 'instantaneous' }, or define a thermalStrain model`,
      path,
    };
  }
  return cteModelProvider(record, cte, basis, path);
}
