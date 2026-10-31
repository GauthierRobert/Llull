/** Property columns of a report: the type and unit come from the class definitions of the objects listed, values are converted to that unit. */

import type { CadDocument } from '@core/model/types';
import { resolvedOrNull } from '../classes';
import { getPlantData, type PlantObject, type PlantValue, type PropertyDefinition } from '../model';
import { convertUnit } from '../units';
import { columnOf, type ReportColumn } from './types';

export interface PropertyReader {
  readonly column: ReportColumn;
  read(object: PlantObject): PlantValue;
}

/** A reader for the property `name` of `objects`, or null when no class of them defines it (the column is then left out). */
export function propertyReader(
  doc: CadDocument,
  objects: readonly PlantObject[],
  name: string,
  displayName: string,
): PropertyReader | null {
  const data = getPlantData(doc);
  const definitions = new Map<string, PropertyDefinition | undefined>();
  const definitionOf = (className: string): PropertyDefinition | undefined => {
    if (!definitions.has(className))
      definitions.set(
        className,
        resolvedOrNull(data, className)?.properties.find((property) => property.name === name),
      );
    return definitions.get(className);
  };
  const first = objects.map((object) => definitionOf(object.className)).find((definition) => definition !== undefined);
  if (first === undefined) return null;
  return {
    column: columnOf(name, displayName, first.type, first.unit ?? null, 'property'),
    read: (object) => {
      const value = object.properties[name] ?? null;
      const definition = definitionOf(object.className);
      if (typeof value !== 'number' || definition === undefined || definition.unit === first.unit || first.unit === undefined) return value;
      return definition.unit === undefined ? value : convertUnit(first.type, value, definition.unit, first.unit);
    },
  };
}
