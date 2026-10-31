/** Equipment list (plant 08 DAT §5.9): one row per equipment-family object with description, hierarchy, size, operating weight and design conditions. */

import { getBuilding } from '@aec/building/model';
import type { EquipmentElement } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { isKindOf } from '../classes';
import { pathOf } from '../hierarchy';
import { getPlantData, type PlantObject } from '../model';
import { convertUnit } from '../units';
import { propertyReader } from './propertyColumns';
import { isUnverified } from './scope';
import { columnOf, round6, type ReportColumn, type ReportRow, type ReportTable } from './types';

export const EQUIPMENT_CLASS = 'Equipment';

function equipmentElement(doc: CadDocument, object: PlantObject): EquipmentElement | undefined {
  const element = object.target.kind === 'buildingElement' ? getBuilding(doc).elements[object.target.id] : undefined;
  return element?.category === 'equipment' ? element : undefined;
}

/** An object of a class below `Equipment`, or one that stands for an equipment element of the model. */
export const isEquipmentObject = (doc: CadDocument, object: PlantObject): boolean =>
  equipmentElement(doc, object) !== undefined || isKindOf(getPlantData(doc), object.className, EQUIPMENT_CLASS);

export function equipmentList(doc: CadDocument, scoped: readonly PlantObject[]): ReportTable {
  const data = getPlantData(doc);
  const objects = scoped.filter((object) => isEquipmentObject(doc, object));
  const readers = (
    [
      ['Description', 'Description'],
      ['DesignPressure', 'Design pressure'],
      ['DesignTemperature', 'Design temperature'],
    ] as const
  ).flatMap(([name, display]) => propertyReader(doc, objects, name, display) ?? []);
  const weight = propertyReader(doc, objects, 'OperatingWeight', 'Operating weight');
  const columns: ReportColumn[] = [
    columnOf('tag', 'Tag', 'text', null, 'derived'),
    columnOf('className', 'Class', 'text', null, 'derived'),
    ...readers.map((reader) => reader.column),
    columnOf('hierarchy', 'Hierarchy', 'text', null, 'derived'),
    columnOf('shape', 'Shape', 'text', null, 'geometry'),
    columnOf('lengthM', 'Length', 'real', 'm', 'geometry'),
    columnOf('widthM', 'Width', 'real', 'm', 'geometry'),
    columnOf('heightM', 'Height', 'real', 'm', 'geometry'),
    columnOf('OperatingWeightKg', 'Operating weight', 'mass', 'kg', 'property'),
    columnOf('unverified', 'Unverified', 'boolean', null, 'derived'),
    columnOf('id', 'ObjectId', 'text', null, 'derived'),
  ];
  let total = 0;
  const rows = objects.map((object): ReportRow => {
    const element = equipmentElement(doc, object);
    const stored = weight === null ? null : weight.read(object);
    const fromProperty =
      typeof stored === 'number' && weight !== null ? convertUnit('mass', stored, weight.column.unit ?? 'kg', 'kg') : null;
    const kilograms = fromProperty ?? (element !== undefined && element.weight > 0 ? element.weight : null);
    total += kilograms ?? 0;
    const size = (index: 0 | 1 | 2): number | null => (element === undefined ? null : round6(toMetres(doc, element.size[index])));
    return {
      tag: object.tag,
      className: object.className,
      ...Object.fromEntries(readers.map((reader) => [reader.column.name, reader.read(object)])),
      hierarchy: pathOf(data, object.hierarchyId),
      shape: element === undefined ? null : (element.shape ?? 'box'),
      lengthM: size(0),
      widthM: size(1),
      heightM: size(2),
      OperatingWeightKg: kilograms,
      unverified: isUnverified(object),
      id: object.id,
    };
  });
  return { columns, rows, keyColumn: 'tag', method: 'none', totals: { equipment: rows.length, weightKg: round6(total) }, defaults: {} };
}
