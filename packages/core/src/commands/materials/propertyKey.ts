/** Identity of a material value (08 MAT): which models compete for the same (property, direction, basis, condition, room / temperature) key. */

import { formVariables, preferenceKey, type PropertyModel } from '../../model/propertyModel';

/** The model depends on temperature (a temperature table or a percent-of-room-temperature ratio). */
export const dependsOnTemperature = (model: PropertyModel): boolean => formVariables(model.form).includes('T');

/** `preferred` is unique per this key: PHY-01 key plus whether the model is a room-temperature value or a temperature law. */
export const valueKey = (model: PropertyModel): string => JSON.stringify([preferenceKey(model), dependsOnTemperature(model)]);

/** Models flagged `preferred` that share a key with another preferred model (each group has at least two). */
export function preferredConflicts(models: readonly PropertyModel[]): PropertyModel[][] {
  const groups = new Map<string, PropertyModel[]>();
  for (const model of models) {
    if (model.preferred !== true) continue;
    const key = valueKey(model);
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}
