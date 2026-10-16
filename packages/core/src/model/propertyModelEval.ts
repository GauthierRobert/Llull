/**
 * Consumer API of property models (PHY-01 TECHNICAL_SPEC §3.3): the ONLY way physics packs read material properties. Resolve a model
 * for a query, evaluate it at an operating point given with units (range guard §5.3, never extrapolates), with derivative, uncertainty
 * band, provenance and the `unverified` / `reviewRequired` flags (§5.7).
 */

import { convertValue, isUnitFailure } from '../lib/quantity';
import { catalogEntry } from './propertyCatalog';
import { evaluateForm, isFormFailure, type BaseEvaluator, type FormResult, type Point } from './propertyForms';
import {
  UNVERIFIED_BASES,
  type Basis,
  type PropertyCondition,
  type PropertyDirection,
  type PropertyModel,
  type PropertyUncertainty,
  type PropertyVariable,
  type Provenance,
  type ValidRange,
} from './propertyModel';

export type VariableValues = Partial<Record<PropertyVariable, { readonly value: number; readonly unit: string }>>;
type RangeStatus = 'in_data_range' | 'in_equation_range_only';

export interface NamedDefault {
  readonly name: string;
  readonly value: number | string | boolean;
  readonly source: string;
  readonly defaulted: true;
}

interface PropertyEvaluationOk {
  readonly available: true;
  readonly value: number;
  readonly unit: string;
  readonly property: string;
  readonly materialId: string;
  readonly modelId: string;
  readonly at: Record<string, { readonly value: number; readonly unit: string; readonly requested: { value: number; unit: string } }>;
  readonly rangeStatus: RangeStatus;
  readonly derivative?: { readonly withRespectTo: PropertyVariable; readonly value: number; readonly unit: string };
  readonly band?: { readonly low: number; readonly high: number; readonly kind: PropertyUncertainty['kind']; readonly coverage?: number };
  readonly basis: Basis;
  readonly provenance: Provenance;
  readonly method: string;
  readonly coefficientsSha256: string;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly defaults: readonly NamedDefault[];
}

export interface PropertyEvaluationRefused {
  readonly available: false;
  readonly code: string;
  readonly reason: string;
  readonly remediation: string;
  readonly path?: string;
  readonly validity?: readonly ValidRange[];
  readonly reviewRequired?: boolean;
  readonly candidates?: readonly { modelId: string; property: string; direction?: string; basis: Basis; validity: readonly ValidRange[] }[];
}

export type PropertyEvaluation = PropertyEvaluationOk | PropertyEvaluationRefused;

export interface PropertyQuery {
  readonly property: string;
  readonly direction?: PropertyDirection;
  readonly basis?: Basis;
  readonly condition?: Partial<PropertyCondition>;
  readonly modelId?: string;
}

/** The record a model hangs off: a document material (name = id) and its models. */
export interface PropertyRecord {
  readonly name: string;
  readonly propertyModels?: readonly PropertyModel[];
}

export interface EvaluateOptions {
  readonly derivative?: PropertyVariable;
  readonly outputUnit?: string;
  readonly band?: boolean;
  readonly forCertification?: boolean;
}

const JC_CLAMP_DEFAULT: NamedDefault = {
  name: 'johnsonCookBelowReferenceRate',
  value: 1,
  source: 'llull rule: no softening below the reference rate (OQ-PROP-08)',
  defaulted: true,
};

const refuse = (
  code: string,
  reason: string,
  remediation: string,
  extra: Partial<PropertyEvaluationRefused> = {},
): PropertyEvaluationRefused => ({ available: false, code, reason, remediation, ...extra });

export const isRefused = (value: PropertyEvaluation | PropertyModel): value is PropertyEvaluationRefused =>
  'available' in value && value.available === false;

const candidateOf = (model: PropertyModel): NonNullable<PropertyEvaluationRefused['candidates']>[number] => ({
  modelId: model.id,
  property: model.property,
  ...(model.direction !== undefined ? { direction: model.direction } : {}),
  basis: model.basis,
  validity: model.validity,
});

/**
 * Model for (property, direction, basis, condition) or an explicit `modelId`; the `preferred` one when several match.
 * @failure no match / several without a preferred one -> PROP_NO_MODEL_FOR_PROPERTY with candidates; unknown modelId -> PROP_MODEL_NOT_FOUND
 */
export function resolvePropertyModel(record: PropertyRecord, query: PropertyQuery): PropertyModel | PropertyEvaluationRefused {
  const models = record.propertyModels ?? [];
  if (query.modelId !== undefined) {
    const found = models.find((model) => model.id === query.modelId);
    return found ?? refuse('PROP_MODEL_NOT_FOUND', `material '${record.name}' has no model '${query.modelId}'`, 'list the material models');
  }
  const forProperty = models.filter((model) => model.property === query.property);
  const matching = forProperty.filter(
    (model) =>
      (query.direction === undefined || model.direction === query.direction) &&
      (query.basis === undefined || model.basis === query.basis) &&
      Object.entries(query.condition ?? {}).every(
        ([key, value]) => (model.condition as Record<string, unknown> | undefined)?.[key] === value,
      ),
  );
  const preferred = matching.filter((model) => model.preferred === true);
  const chosen = matching.length === 1 ? matching[0] : preferred.length === 1 ? preferred[0] : undefined;
  if (chosen !== undefined) return chosen;
  return refuse(
    'PROP_NO_MODEL_FOR_PROPERTY',
    matching.length > 1
      ? `${matching.length} models of ${query.property} on '${record.name}' match and none is preferred`
      : `material '${record.name}' has no ${query.property} model for this direction / basis / condition`,
    'pick a candidate explicitly (modelId) or define a sourced model with define_property_model',
    { candidates: (matching.length > 1 ? matching : forProperty).map(candidateOf) },
  );
}

const scaleOf = (from: string, to: string): number | null => {
  const one = convertValue(1, from, to);
  const zero = convertValue(0, from, to);
  return isUnitFailure(one) || isUnitFailure(zero) ? null : one.value - zero.value;
};

const methodOf = (model: PropertyModel): string => {
  const form = model.form;
  const count = 'coefficients' in form ? `(${form.coefficients.length})` : '';
  return `${form.kind}${count} ${model.provenance.sourceId ?? model.provenance.citation ?? ''}`.trim();
};

interface GuardedPoint {
  readonly point: Point;
  readonly at: PropertyEvaluationOk['at'];
  readonly rangeStatus: RangeStatus;
}

/** Convert each variable to the model units and apply the range guard (§5.3). */
function guardPoint(model: PropertyModel, at: VariableValues): GuardedPoint | PropertyEvaluationRefused {
  const point: Partial<Record<PropertyVariable, number>> = {};
  const echoed: Record<string, PropertyEvaluationOk['at'][string]> = {};
  let rangeStatus: RangeStatus = 'in_data_range';
  for (const spec of model.variables) {
    let value = Number.NaN;
    const requested = at[spec.variable];
    if (requested === undefined) {
      return refuse(
        'PROP_VARIABLE_MISSING',
        `model '${model.id}' needs ${spec.variable}`,
        `give at.${spec.variable} = { value, unit: '${spec.unit}' }`,
        { path: `at.${spec.variable}`, validity: model.validity },
      );
    }
    const converted = convertValue(requested.value, requested.unit, spec.unit);
    if (isUnitFailure(converted)) {
      return refuse(
        converted.code,
        `at.${spec.variable}: ${converted.message}`,
        `give ${spec.variable} in a unit of the same dimension as '${spec.unit}'`,
        { path: `at.${spec.variable}.unit` },
      );
    }
    const range = model.validity.find((r) => r.variable === spec.variable);
    if (range !== undefined) {
      const inRangeUnit = convertValue(converted.value, spec.unit, range.unit);
      const v = isUnitFailure(inRangeUnit) ? converted.value : inRangeUnit.value;
      const equation = range.equation ?? range.data;
      const eps = (bound: number): number => 1e-12 * Math.max(1, Math.abs(bound));
      if (v < equation[0] - eps(equation[0]) || v > equation[1] + eps(equation[1])) {
        return refuse(
          'PROP_OUT_OF_RANGE',
          `${spec.variable} = ${v} ${range.unit} is outside the valid range [${equation[0]}, ${equation[1]}] ${range.unit} of '${model.id}'`,
          'stay in range or define a model sourced for that range; llull never extrapolates',
          { path: `at.${spec.variable}`, validity: model.validity },
        );
      }
      if (v < range.data[0] - eps(range.data[0]) || v > range.data[1] + eps(range.data[1])) rangeStatus = 'in_equation_range_only';
      const bound = v < equation[0] ? equation[0] : v > equation[1] ? equation[1] : undefined;
      const snapped = bound === undefined ? undefined : convertValue(bound, range.unit, spec.unit);
      if (snapped !== undefined && !isUnitFailure(snapped)) value = snapped.value;
    }
    if (Number.isNaN(value)) value = converted.value;
    point[spec.variable] = value;
    echoed[spec.variable] = { value, unit: spec.unit, requested: { value: requested.value, unit: requested.unit } };
  }
  return { point, at: echoed, rangeStatus };
}

/** Evaluator of `ratioOf` bases inside the same record (base variables share the ratio model's units). */
export const baseEvaluatorOf =
  (record: PropertyRecord, depth = 0): BaseEvaluator =>
  (baseModelId, point, wrt): FormResult => {
    const base = record.propertyModels?.find((model) => model.id === baseModelId);
    if (base === undefined || depth > 8) return { code: 'PROP_MODEL_NOT_FOUND', message: `base model '${baseModelId}' not found` };
    return evaluateForm(base.form, point, wrt, baseEvaluatorOf(record, depth + 1));
  };

/** Reasons a model's values are not verified (basis, fit review), before the range status is known. */
export function modelUnverifiedReasons(model: PropertyModel): string[] {
  const reasons: string[] = [];
  if (UNVERIFIED_BASES.has(model.basis)) reasons.push(`basis ${model.basis}`);
  if (model.fit !== undefined && model.fit.dataProvenance === undefined) reasons.push('fit without data provenance');
  if (model.fit !== undefined && model.reviewedBy === undefined) reasons.push('fit not reviewed');
  return reasons;
}

const usesJcClamp = (model: PropertyModel, point: Point): boolean => {
  const walk = (form: PropertyModel['form']): boolean =>
    (form.kind === 'rateFactor' && form.law === 'johnsonCook' && (point.strainRate ?? Number.POSITIVE_INFINITY) < form.referenceRate) ||
    (form.kind === 'product' && form.factors.some(walk)) ||
    (form.kind === 'piecewise' && form.segments.some((segment) => walk(segment.form))) ||
    (form.kind === 'ratioOf' && walk(form.ratio));
  return walk(model.form);
};

/**
 * Evaluate `model` (of `record`) at `at`.
 * @invariant never extrapolates outside the equation range; never returns NaN / ±∞ (PROP_NONFINITE)
 * @failure PROP_VARIABLE_MISSING, PROP_OUT_OF_RANGE, MAT_UNIT_*, PROP_DERIVATIVE_UNAVAILABLE, PROP_NONFINITE, MAT_VALUE_UNVERIFIED
 */
export function evaluatePropertyModel(
  record: PropertyRecord,
  model: PropertyModel,
  at: VariableValues,
  options: EvaluateOptions = {},
): PropertyEvaluation {
  const guarded = guardPoint(model, at);
  if ('available' in guarded) return guarded;
  const result = evaluateForm(model.form, guarded.point, options.derivative, baseEvaluatorOf(record));
  if (isFormFailure(result)) {
    const remediation =
      result.code === 'PROP_DERIVATIVE_UNAVAILABLE'
        ? 'use a continuous interpolation mode'
        : 'check the model definition against its source';
    return refuse(result.code, `'${model.id}': ${result.message}`, remediation, { validity: model.validity });
  }
  if (!Number.isFinite(result.value) || (result.derivative !== undefined && !Number.isFinite(result.derivative))) {
    return refuse(
      'PROP_NONFINITE',
      `'${model.id}' is not finite at this point`,
      'the model is malformed in this range; check coefficients against the source',
    );
  }
  const unit = options.outputUnit ?? model.unit;
  const converted = convertValue(result.value, model.unit, unit);
  if (isUnitFailure(converted))
    return refuse(converted.code, `outputUnit: ${converted.message}`, `ask for a unit of the same dimension as '${model.unit}'`, {
      path: 'outputUnit',
    });
  const reasons = modelUnverifiedReasons(model);
  const warnings: { code: string; message: string }[] = [];
  if (guarded.rangeStatus === 'in_equation_range_only') {
    reasons.push('outside data range');
    warnings.push({
      code: 'PROP_OUTSIDE_DATA_RANGE',
      message: `'${model.id}' is evaluated inside its equation range but outside its data range`,
    });
  }
  const strength = catalogEntry(model.property)?.strength ?? false;
  const reviewRequired = options.forCertification === true || strength || (model.fit !== undefined && model.reviewedBy === undefined);
  if (options.forCertification === true && reasons.length > 0) {
    return refuse(
      'MAT_VALUE_UNVERIFIED',
      `'${model.id}' is unverified (${reasons.join(', ')}) and cannot be used for certification`,
      'use a verified basis and sourced, reviewed model',
      { reviewRequired: true },
    );
  }
  const scale = scaleOf(model.unit, unit) ?? 1;
  let band: PropertyEvaluationOk['band'];
  const uncertainty = model.uncertainty;
  if (options.band === true && uncertainty !== undefined) {
    const half =
      uncertainty.relative !== undefined
        ? Math.abs(converted.value) * uncertainty.relative
        : uncertainty.absolute !== undefined
          ? Math.abs(uncertainty.absolute.value * (scaleOf(uncertainty.absolute.unit, unit) ?? 1))
          : 0;
    band = {
      low: converted.value - half,
      high: converted.value + half,
      kind: uncertainty.kind,
      ...(uncertainty.kind === 'statistical' && uncertainty.coverage !== undefined ? { coverage: uncertainty.coverage } : {}),
    };
  }
  const variableUnit = model.variables.find((spec) => spec.variable === options.derivative)?.unit ?? '1';
  return {
    available: true,
    value: converted.value,
    unit,
    property: model.property,
    materialId: record.name,
    modelId: model.id,
    at: guarded.at,
    rangeStatus: guarded.rangeStatus,
    ...(options.derivative !== undefined && result.derivative !== undefined
      ? { derivative: { withRespectTo: options.derivative, value: result.derivative * scale, unit: `(${unit})/(${variableUnit})` } }
      : {}),
    ...(band !== undefined ? { band } : {}),
    basis: model.basis,
    provenance: model.provenance,
    method: methodOf(model),
    coefficientsSha256: model.coefficientsSha256,
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    reviewRequired,
    warnings,
    defaults: usesJcClamp(model, guarded.point) ? [JC_CLAMP_DEFAULT] : [],
  };
}

/**
 * Instantaneous CTE α(T) = s′(T) / (1 + s(T)) from a `thermalStrain` model (llull derivation, reported in `method`).
 * @failure as evaluatePropertyModel
 */
export function cteFromThermalStrain(
  record: PropertyRecord,
  model: PropertyModel,
  at: VariableValues,
  options: EvaluateOptions = {},
): PropertyEvaluation {
  const strain = evaluatePropertyModel(record, model, at, { ...options, outputUnit: '1', derivative: 'T', band: false });
  if (!strain.available || strain.derivative === undefined) return strain;
  const variableUnit = model.variables.find((spec) => spec.variable === 'T')?.unit ?? 'K';
  const unit = options.outputUnit ?? '1/K';
  const scale = scaleOf(`1/(${variableUnit})`, unit);
  if (scale === null)
    return refuse('MAT_UNIT_DIMENSION', `outputUnit '${unit}' is not an inverse temperature`, "ask for '1/K'", { path: 'outputUnit' });
  const scaled = (strain.derivative.value / (1 + strain.value)) * scale;
  return {
    ...strain,
    value: scaled,
    unit,
    property: 'cte',
    method: `instantaneous CTE s'(T)/(1 + s(T)) from ${strain.method} (llull derivation)`,
  };
}
