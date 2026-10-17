/** Exact-key lookup of a material value (VC-MAT-05): a basis, direction, thickness, e/D or temperature is never substituted. */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import type { PropertyDirection, PropertyModel } from '../../model/propertyModel';
import { dependsOnTemperature } from './propertyKey';

export interface AllowableQuery {
  readonly property: string;
  readonly basis: PropertyModel['basis'];
  readonly direction?: PropertyDirection | 'isotropic' | undefined;
  readonly thickness?: { readonly value: number; readonly unit: string } | undefined;
  readonly edOverD?: number | undefined;
  readonly temperature?: { readonly value: number; readonly unit: string } | undefined;
}

const EPSILON = 1e-9;

function thicknessMatches(model: PropertyModel, query: AllowableQuery): boolean {
  const range = model.condition?.thickness;
  if (range === undefined) return true;
  if (query.thickness === undefined) return false;
  const converted = convertValue(query.thickness.value, query.thickness.unit, range.unit);
  return !isUnitFailure(converted) && converted.value >= range.min - EPSILON && converted.value <= range.max + EPSILON;
}

/**
 * Models of the exact key: same property and basis, direction (absent = isotropic), a thickness range containing the query, equal e/D, and
 * a temperature law exactly when a temperature is asked.
 */
export function modelsForKey(models: readonly PropertyModel[], query: AllowableQuery): PropertyModel[] {
  const direction = query.direction === 'isotropic' ? undefined : query.direction;
  return models.filter(
    (model) =>
      model.property === query.property &&
      model.basis === query.basis &&
      model.direction === direction &&
      thicknessMatches(model, query) &&
      (model.condition?.edOverD === undefined || model.condition.edOverD === query.edOverD) &&
      dependsOnTemperature(model) === (query.temperature !== undefined),
  );
}

/** What an agent may pick instead: every value of the property, with its key. */
export function candidateOf(model: PropertyModel): Record<string, unknown> {
  return {
    modelId: model.id,
    basis: model.basis,
    ...(model.direction !== undefined ? { direction: model.direction } : {}),
    ...(model.condition !== undefined ? { condition: model.condition } : {}),
    unit: model.unit,
    temperatureDependent: dependsOnTemperature(model),
    preferred: model.preferred === true,
    ...(model.form.kind === 'constant' ? { value: model.form.value } : {}),
  };
}
