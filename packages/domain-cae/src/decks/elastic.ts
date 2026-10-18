/** Linear-elastic constants (E, nu) of a document material, in MPa, read through the PHY-02 / PHY-01 consumer APIs. */

import type { AnalysisCase } from '@core/model/analysis';
import type { Material } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { setMembers, findSet } from '@core/model/materialLaws/combination';
import { isLawFailure, newTrace, resolveAll, type ResolveEnv } from '@core/model/materialLaws/resolve';
import { evaluatePropertyModel, isRefused, resolvePropertyModel, type PropertyRecord } from '@core/model/propertyModelEval';

/** Temperature (K) properties are read at when the case gives none: 20 degC. */
export const ROOM_TEMPERATURE_K = 293.15;

/** Temperature (K) properties are read at: the thermo-mechanical reference temperature when the case has one, else 20 degC. */
export function propertyTemperatureK(analysis: AnalysisCase): number {
  const reference = analysis.thermomech?.referenceTemperature;
  if (reference === undefined) return ROOM_TEMPERATURE_K;
  const kelvin = convertValue(reference.value, reference.unit, 'K');
  return isUnitFailure(kelvin) ? ROOM_TEMPERATURE_K : kelvin.value;
}

export interface ElasticConstants {
  /** Young's modulus, MPa. */
  readonly E: number;
  readonly nu: number;
  /** Where the values came from, e.g. "constitutive set cs1 (elastic_isotropic)" or "property models E, nu". */
  readonly source: string;
  /** Reasons the values are unverified (PHY-01 flags), empty when verified. */
  readonly unverifiedReasons: readonly string[];
}

export interface ElasticRefusal {
  readonly code: string;
  readonly message: string;
}

export const isElasticRefusal = (value: ElasticConstants | ElasticRefusal): value is ElasticRefusal => 'code' in value;

const validate = (
  name: string,
  E: number,
  nu: number,
  source: string,
  unverifiedReasons: readonly string[],
): ElasticConstants | ElasticRefusal => {
  if (!(E > 0) || !Number.isFinite(E)) return { code: 'FEA_PROPERTY_INVALID', message: `material '${name}': E = ${E} MPa must be > 0` };
  if (!(nu > -1 && nu < 0.5)) return { code: 'FEA_PROPERTY_INVALID', message: `material '${name}': nu = ${nu} must be in (-1, 0.5)` };
  return { E, nu, source, unverifiedReasons };
};

/**
 * E and nu of `material` (named `name`) at `temperatureK`. Order: the default constitutive set (else the first set with an elastic
 * member) when its elastic model is `elastic_isotropic`; otherwise the PHY-01 property models `E` and `nu`.
 * @failure no E / nu -> FEA_MATERIAL_NO_ELASTIC; other elastic law -> FEA_MATERIAL_ELASTIC_UNSUPPORTED; E <= 0 or nu outside (-1, 0.5) ->
 *   FEA_PROPERTY_INVALID; a property-model refusal (e.g. PROP_OUT_OF_RANGE) passes its own code through
 */
export function elasticConstants(material: Material, name: string, temperatureK: number): ElasticConstants | ElasticRefusal {
  const record: PropertyRecord = { name, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  const at = { T: { value: temperatureK, unit: 'K' } };
  const sets = material.constitutiveSets;
  const set = findSet(sets, material.defaultConstitutiveSet) ?? sets?.find((candidate) => candidate.elastic !== undefined);
  const law = set === undefined ? undefined : setMembers(set, material.materialModels ?? []).elastic;
  if (set !== undefined && law !== undefined) {
    if (law.model.kind !== 'elastic_isotropic')
      return {
        code: 'FEA_MATERIAL_ELASTIC_UNSUPPORTED',
        message: `material '${name}': constitutive set '${set.id}' uses ${law.model.kind}; only elastic_isotropic is written`,
      };
    const trace = newTrace();
    const env: ResolveEnv = { record, at, trace };
    const resolved = resolveAll(
      { E: { parameter: law.model.E, dimension: 'stress' }, nu: { parameter: law.model.nu, dimension: 'dimensionless' } },
      env,
      `models.${law.id}`,
    );
    if (isLawFailure(resolved)) return { code: resolved.code, message: `material '${name}': ${resolved.message}` };
    return validate(name, resolved.E, resolved.nu, `constitutive set ${set.id} (elastic_isotropic)`, [...trace.unverifiedReasons]);
  }
  const modelE = resolvePropertyModel(record, { property: 'E' });
  const modelNu = resolvePropertyModel(record, { property: 'nu' });
  if (isRefused(modelE) || isRefused(modelNu))
    return {
      code: 'FEA_MATERIAL_NO_ELASTIC',
      message: `material '${name}' has no elastic_isotropic constitutive set and no property model for ${isRefused(modelE) ? 'E' : 'nu'}`,
    };
  const evalE = evaluatePropertyModel(record, modelE, at, { outputUnit: 'MPa' });
  const evalNu = evaluatePropertyModel(record, modelNu, at, { outputUnit: '1' });
  if (!evalE.available) return { code: evalE.code, message: `material '${name}' E: ${evalE.reason}` };
  if (!evalNu.available) return { code: evalNu.code, message: `material '${name}' nu: ${evalNu.reason}` };
  return validate(name, evalE.value, evalNu.value, `property models ${modelE.id}, ${modelNu.id}`, [
    ...evalE.unverifiedReasons.map((reason) => `E: ${reason}`),
    ...evalNu.unverifiedReasons.map((reason) => `nu: ${reason}`),
  ]);
}

/** Step (K) between the temperatures of a temperature-dependent `*ELASTIC` table. */
const ELASTIC_TABLE_STEP_KELVIN = 10;
/** Most intervals of an `*ELASTIC` table, whatever the range (a wider range gets a coarser step). */
const ELASTIC_TABLE_MAX_INTERVALS = 100;

/** Rows of `*ELASTIC`: `[E, nu]` (constant) or `[E, nu, kelvin]` (E, nu tabulated against temperature). */
interface ElasticTable {
  readonly rows: readonly (readonly [number, number] | readonly [number, number, number])[];
  readonly source: string;
  readonly unverifiedReasons: readonly string[];
}

/**
 * E and nu of `material` over [`lowKelvin`, `highKelvin`] (extended to contain `referenceKelvin`): one constant row when neither depends
 * on temperature, else rows `[E, nu, kelvin]` every 10 K (at most 100 intervals), both ends evaluated first.
 * @failure any `elasticConstants` refusal at a sampled temperature (e.g. PROP_OUT_OF_RANGE when the field leaves the model validity)
 */
export function elasticTable(
  material: Material,
  name: string,
  referenceKelvin: number,
  lowKelvin: number,
  highKelvin: number,
): ElasticTable | ElasticRefusal {
  const low = Math.min(lowKelvin, referenceKelvin);
  const high = Math.max(highKelvin, referenceKelvin);
  const atReference = elasticConstants(material, name, referenceKelvin);
  if (isElasticRefusal(atReference)) return atReference;
  const intervals = high - low < 1e-9 ? 0 : Math.min(ELASTIC_TABLE_MAX_INTERVALS, Math.ceil((high - low) / ELASTIC_TABLE_STEP_KELVIN));
  if (intervals === 0)
    return { rows: [[atReference.E, atReference.nu]], source: atReference.source, unverifiedReasons: atReference.unverifiedReasons };
  const samples = Array.from({ length: intervals + 1 }, (_, i) => low + ((high - low) * i) / intervals);
  const values: { readonly kelvin: number; readonly constants: ElasticConstants }[] = [];
  for (const kelvin of [low, high, ...samples.slice(1, -1)]) {
    const constants = elasticConstants(material, name, kelvin);
    if (isElasticRefusal(constants)) return constants;
    values.push({ kelvin, constants });
  }
  values.sort((a, b) => a.kelvin - b.kelvin);
  const first = values[0]?.constants ?? atReference;
  const reasons = [...new Set(values.flatMap(({ constants }) => constants.unverifiedReasons))];
  if (values.every(({ constants }) => constants.E === first.E && constants.nu === first.nu))
    return { rows: [[first.E, first.nu]], source: first.source, unverifiedReasons: reasons };
  return {
    rows: values.map(({ kelvin, constants }) => [constants.E, constants.nu, kelvin] as const),
    source: first.source,
    unverifiedReasons: reasons,
  };
}
