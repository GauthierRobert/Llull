/** Hot Young's modulus E(T) of the operating cases (07 PST §5.2, named setting `hotModulus` of the model): read from the `E` property model of a document material. */

import { evaluatePropertyModel, isRefused, resolvePropertyModel, type PropertyRecord } from '@core/model/propertyModelEval';
import type { CadDocument } from '@core/model/types';
import type { LoadCaseDef, OperatingConditions, StressModel } from '../model/schema';
import type { PrimitiveFailure } from './primitives';

const KELVIN = 273.15;

export interface HotModulus {
  readonly ok: true;
  readonly modulusMPa: number;
  readonly tempC: number;
  readonly unverified: readonly string[];
}

/** The metal temperature a case runs at: the largest T primitive of its `basic` list (null when it has none). */
export function caseTemperatureC(loadCase: LoadCaseDef, conditions: OperatingConditions): number | null {
  const temps = conditions.temperatures.filter((entry) => (loadCase.basic ?? []).includes(entry.name)).map((entry) => entry.tempC);
  return temps.length === 0 ? null : Math.max(...temps);
}

/**
 * E at the temperature of an OPE case when the model asks for the hot modulus; null when it does not apply (no setting, not an OPE case, no T primitive).
 * @failure no material -> PST_MATERIAL_NOT_FOUND; no E model -> PST_MATERIAL_NO_DATA; temperature outside the table -> PST_TEMPERATURE_OUT_OF_TABLE (never extrapolated)
 */
export function hotModulusOf(
  doc: Pick<CadDocument, 'materials'>,
  model: Pick<StressModel, 'hotModulus'>,
  conditions: OperatingConditions,
  loadCase: LoadCaseDef,
): HotModulus | PrimitiveFailure | null {
  if (model.hotModulus === undefined || loadCase.type !== 'OPE') return null;
  const tempC = caseTemperatureC(loadCase, conditions);
  if (tempC === null) return null;
  const path = 'hotModulus';
  const { materialId } = model.hotModulus;
  const material = doc.materials !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (material === undefined)
    return { ok: false, code: 'PST_MATERIAL_NOT_FOUND', message: `hotModulus: no document material "${materialId}"`, path };
  const record: PropertyRecord = {
    name: materialId,
    ...(material.propertyModels === undefined ? {} : { propertyModels: material.propertyModels }),
  };
  const found = resolvePropertyModel(record, { property: 'E' });
  if (isRefused(found)) return { ok: false, code: 'PST_MATERIAL_NO_DATA', message: `hotModulus: ${found.reason} (${found.code})`, path };
  const value = evaluatePropertyModel(record, found, { T: { value: tempC + KELVIN, unit: 'K' } }, { outputUnit: 'MPa' });
  if (!value.available)
    return {
      ok: false,
      code: value.code === 'PROP_OUT_OF_RANGE' ? 'PST_TEMPERATURE_OUT_OF_TABLE' : 'PST_MATERIAL_NO_DATA',
      message: `hotModulus: case ${loadCase.name} at ${tempC} degC: ${value.reason} (${value.code})`,
      path,
    };
  return { ok: true, modulusMPa: value.value, tempC, unverified: value.unverifiedReasons };
}
