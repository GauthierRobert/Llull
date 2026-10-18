/** Strength allowables for compute_margins: PHY-01 property models `Ftu` / `Fty` of a part's material, or an explicit value. */

import type { Material } from '@core/model/types';
import { evaluatePropertyModel, isRefused, resolvePropertyModel, type PropertyRecord } from '@core/model/propertyModelEval';
import { convertValue, isUnitFailure } from '@lib/quantity';

export type AllowableProperty = 'Ftu' | 'Fty';

/** An allowable in MPa with where it came from. */
export interface Allowable {
  readonly valueMpa: number;
  /** `Ftu` | `Fty` | `explicit`. */
  readonly property: string;
  readonly basis: string;
  readonly provenance: string;
  readonly unverifiedReasons: readonly string[];
  /** False for a constant model or an explicit value: the strength does not change with temperature. */
  readonly temperatureDependent: boolean;
  /** Temperature [K] the value was evaluated at (the less favourable end of the region), when evaluated. */
  readonly temperatureK?: number;
}

export interface AllowableRefusal {
  readonly code: 'FEA_MATERIAL_NO_ALLOWABLE';
  readonly message: string;
}

export const isAllowableRefusal = (value: Allowable | AllowableRefusal): value is AllowableRefusal => 'code' in value;

/**
 * `property` of `material` at `temperatureK`, in MPa.
 * @failure no model, several models without a preferred one, temperature outside the validity range, or a non-positive value ->
 *   FEA_MATERIAL_NO_ALLOWABLE (the PHY-01 code and reason in the message)
 */
export function materialAllowable(
  material: Material,
  materialId: string,
  property: AllowableProperty,
  temperatureK: number,
): Allowable | AllowableRefusal {
  const record: PropertyRecord = {
    name: materialId,
    ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}),
  };
  const fail = (reason: string): AllowableRefusal => ({
    code: 'FEA_MATERIAL_NO_ALLOWABLE',
    message: `material '${materialId}' has no usable ${property} at ${temperatureK} K: ${reason}`,
  });
  const model = resolvePropertyModel(record, { property });
  if (isRefused(model)) return fail(`${model.code} — ${model.reason}`);
  const evaluated = evaluatePropertyModel(record, model, { T: { value: temperatureK, unit: 'K' } }, { outputUnit: 'MPa' });
  if (!evaluated.available) return fail(`${evaluated.code} — ${evaluated.reason}`);
  if (!(evaluated.value > 0)) return fail(`the model '${model.id}' gives ${evaluated.value} MPa (must be > 0)`);
  const { provenance } = evaluated;
  const cited = [provenance.citation, provenance.locator].filter((part): part is string => part !== undefined && part !== '').join(' ');
  return {
    valueMpa: evaluated.value,
    property,
    basis: evaluated.basis,
    provenance: `material ${materialId} model ${evaluated.modelId}${cited === '' ? '' : `: ${cited}`}`,
    unverifiedReasons: evaluated.unverifiedReasons.map((reason) => `${property}: ${reason}`),
    temperatureDependent: model.form.kind !== 'constant',
    temperatureK,
  };
}

/**
 * `property` over a temperature region: the lower of the values at its coldest and hottest temperature (conservative for strength that
 * falls with heat and for cold-embrittled materials alike).
 * @failure as `materialAllowable`, at either end of the region
 */
export function materialAllowableOver(
  material: Material,
  materialId: string,
  property: AllowableProperty,
  rangeK: readonly [number, number],
): Allowable | AllowableRefusal {
  const ends = [rangeK[0], rangeK[1]].map((temperatureK) => materialAllowable(material, materialId, property, temperatureK));
  for (const end of ends) if (isAllowableRefusal(end)) return end;
  const [cold, hot] = ends as [Allowable, Allowable];
  return hot.valueMpa <= cold.valueMpa ? hot : cold;
}

/**
 * An explicit allowable `{ value, unit }` in MPa.
 * @failure non-finite / non-positive value or a unit that is not a stress -> FEA_MATERIAL_NO_ALLOWABLE
 */
export function explicitAllowable(value: number, unit: string): Allowable | AllowableRefusal {
  const converted = convertValue(value, unit, 'MPa');
  if (isUnitFailure(converted) || !(converted.value > 0) || !Number.isFinite(converted.value))
    return {
      code: 'FEA_MATERIAL_NO_ALLOWABLE',
      message: `the explicit allowable ${value} ${unit} must be a positive stress (MPa, Pa, psi, ksi, ...)`,
    };
  return {
    valueMpa: converted.value,
    property: 'explicit',
    basis: 'unspecified',
    provenance: `given by the caller: ${value} ${unit}`,
    unverifiedReasons: ['allowable given by the caller without a material record'],
    temperatureDependent: false,
  };
}
