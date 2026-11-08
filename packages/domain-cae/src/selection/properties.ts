/** Property resolution of a selection (PHY-12 TR-SEL-02): the 08 / PHY-01 value of a material, converted to a base unit, with its basis and provenance. */

import { resolveDensity } from '@core/geometry/resolveDensity';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { formVariables, type PropertyDirection, type PropertyModel, type Provenance } from '@core/model/propertyModel';
import { evaluatePropertyModel, isRefused, type PropertyRecord } from '@core/model/propertyModelEval';
import type { CadDocument } from '@core/model/types';
import type { PropertyUse, Quantity } from './types';

export interface ResolveOptions {
  readonly direction?: PropertyDirection | undefined;
  readonly thickness?: Quantity | undefined;
  readonly temperature?: Quantity | undefined;
}

export type Resolved =
  | { readonly ok: true; readonly use: PropertyUse }
  | { readonly ok: false; readonly code: string; readonly property: string; readonly reason: string };

const missing = (property: string, reason: string, code = 'SEL_PROPERTY_MISSING'): Resolved => ({ ok: false, code, property, reason });

const usesTemperature = (model: PropertyModel): boolean => formVariables(model.form).includes('T');

const provenanceText = (provenance: Provenance): string => {
  const source = provenance.citation ?? provenance.sourceId ?? 'no source';
  return provenance.locator === undefined ? source : `${source}, ${provenance.locator}`;
};

function thicknessAllows(model: PropertyModel, thickness: Quantity | undefined): boolean {
  const band = model.condition?.thickness;
  if (band === undefined) return true;
  if (thickness === undefined) return false;
  const converted = convertValue(thickness.value, thickness.unit, band.unit);
  return !isUnitFailure(converted) && converted.value >= band.min - 1e-9 && converted.value <= band.max + 1e-9;
}

/** Models able to answer: the asked direction (an isotropic value answers any direction), a thickness band that holds the product. */
function candidatesOf(models: readonly PropertyModel[], property: string, options: ResolveOptions): PropertyModel[] {
  const ofProperty = models.filter(
    (model) =>
      model.property === property &&
      thicknessAllows(model, options.thickness) &&
      (model.direction === undefined || model.direction === options.direction),
  );
  const exact = ofProperty.filter((model) => model.direction !== undefined);
  return exact.length > 0 ? exact : ofProperty;
}

const describeKey = (property: string, options: ResolveOptions): string =>
  `${property}${options.direction !== undefined ? ` (direction ${options.direction})` : ''}${
    options.temperature !== undefined ? ` at ${options.temperature.value} ${options.temperature.unit}` : ''
  }`;

/** Density of a legacy material (no density model): the 08 resolver, flagged unverified. */
function legacyDensity(doc: CadDocument, materialId: string, atTemperature: boolean): Resolved {
  const density = resolveDensity(doc, materialId);
  if (density === null || !density.available)
    return missing('density', density === null ? 'no density' : density.reason, density === null ? undefined : density.code);
  const value = convertValue(density.kgPerM3, 'kg/m^3', 'Mg/m^3');
  if (isUnitFailure(value)) return missing('density', value.message, value.code);
  return {
    ok: true,
    use: {
      property: 'density',
      value: value.value,
      unit: 'Mg/m^3',
      basis: density.basis ?? 'unspecified',
      propertyValueId: density.modelId ?? 'legacy-density',
      provenance: density.source,
      unverified: density.unverified || atTemperature,
      unverifiedReasons: atTemperature
        ? [...density.unverifiedReasons, 'density read at 20 degC (no temperature law)']
        : density.unverifiedReasons,
    },
  };
}

/**
 * The value of `property` of `materialId` in `unit`. Never imputed: no value, an ambiguous pick (several values, none preferred), an unusable
 * private record or a PHY-01 refusal (range, unit) is a failure with its code.
 * @invariant a density without a temperature law is read at 20 degC and says so in unverifiedReasons; every other property needs a temperature law when a temperature is asked
 */
export function resolveProperty(
  doc: CadDocument,
  materialId: string,
  property: string,
  unit: string,
  options: ResolveOptions = {},
): Resolved {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (material === undefined) return missing(property, `no material '${materialId}'`, 'SEL_MATERIAL_NOT_FOUND');
  if (material.record?.unresolved !== undefined)
    return missing(
      property,
      `private library values are not on this machine (${material.record.unresolved.reason})`,
      'MAT_LIBRARY_UNRESOLVED',
    );
  const models = material.propertyModels ?? [];
  const found = candidatesOf(models, property, options);
  const temperatureLaws = found.filter(usesTemperature);
  const pool = options.temperature === undefined ? found.filter((model) => !usesTemperature(model)) : temperatureLaws;
  const densityAtRoomTemperature = property === 'density' && options.temperature !== undefined && temperatureLaws.length === 0;
  const picked = densityAtRoomTemperature ? found.filter((model) => !usesTemperature(model)) : pool;
  if (property === 'density' && models.every((model) => model.property !== 'density')) {
    // a record without a density value has none (its legacy field is a 0 placeholder); a plain create_material density is legacy
    return material.record !== undefined
      ? missing(property, 'no density value')
      : legacyDensity(doc, materialId, options.temperature !== undefined);
  }
  if (picked.length === 0)
    return missing(
      property,
      found.length === 0
        ? `no ${describeKey(property, options)} value`
        : `${property} has no temperature law for ${describeKey(property, options)} (the room-temperature value is not extended to another temperature)`,
    );
  const preferred = picked.filter((model) => model.preferred === true);
  const chosen = picked.length === 1 ? picked[0] : preferred.length === 1 ? preferred[0] : undefined;
  if (chosen === undefined)
    return missing(
      property,
      `${picked.length} values of ${describeKey(property, options)} (${picked.map((model) => `${model.id}: basis ${model.basis}`).join('; ')}) and none preferred`,
      'SEL_PROPERTY_AMBIGUOUS',
    );
  const record: PropertyRecord = { name: materialId, propertyModels: models };
  const at = options.temperature !== undefined && usesTemperature(chosen) ? { T: options.temperature } : {};
  const evaluated = evaluatePropertyModel(record, chosen, at, { outputUnit: unit });
  if (isRefused(evaluated)) return missing(property, `${evaluated.reason} (${evaluated.remediation})`, evaluated.code);
  const reasons = densityAtRoomTemperature
    ? [...evaluated.unverifiedReasons, 'density read at 20 degC (no temperature law)']
    : evaluated.unverifiedReasons;
  return {
    ok: true,
    use: {
      property,
      value: evaluated.value,
      unit,
      basis: evaluated.basis,
      propertyValueId: chosen.id,
      provenance: provenanceText(evaluated.provenance),
      ...(chosen.direction !== undefined ? { direction: chosen.direction } : {}),
      ...(options.temperature !== undefined && usesTemperature(chosen) ? { temperature: options.temperature } : {}),
      unverified: reasons.length > 0,
      unverifiedReasons: reasons,
    },
  };
}
