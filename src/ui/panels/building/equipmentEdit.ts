// Equipment form spec: element → texts → changed `update_equipment` params (untouched fields omitted: exact revision).

import type { EquipmentElement } from '@aec/building/types';
import { toDegrees, toRadians } from '@lib/angle';
import { FieldReader, result } from './elementToolForm';

type EquipmentEditKey =
  | 'mark'
  | 'name'
  | 'x'
  | 'y'
  | 'length'
  | 'width'
  | 'height'
  | 'angle'
  | 'clearance'
  | 'weight'
  | 'levelId'
  | 'shape';

export type EquipmentEditValues = Readonly<Record<EquipmentEditKey, string>>;

interface EquipmentEditField {
  readonly key: EquipmentEditKey;
  readonly label: string;
  readonly kind: 'text' | 'number';
}

export const EQUIPMENT_EDIT_FIELDS: ReadonlyArray<EquipmentEditField> = [
  { key: 'mark', label: 'Tag', kind: 'text' },
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'x', label: 'Centre X', kind: 'number' },
  { key: 'y', label: 'Centre Y', kind: 'number' },
  { key: 'length', label: 'Length', kind: 'number' },
  { key: 'width', label: 'Width', kind: 'number' },
  { key: 'height', label: 'Height', kind: 'number' },
  { key: 'angle', label: 'Rotation (°)', kind: 'number' },
  { key: 'clearance', label: 'Clearance', kind: 'number' },
  { key: 'weight', label: 'Weight (kg)', kind: 'number' },
];

export function equipmentValues(element: EquipmentElement): EquipmentEditValues {
  return {
    mark: element.mark,
    name: element.name,
    x: String(element.location[0]),
    y: String(element.location[1]),
    length: String(element.size[0]),
    width: String(element.size[1]),
    height: String(element.size[2]),
    angle: String(toDegrees(element.angle, 6)),
    clearance: String(element.clearance),
    weight: String(element.weight),
    levelId: element.levelId,
    shape: element.shape ?? 'box',
  };
}

type EquipmentEdit = { readonly ok: true; readonly params: Record<string, unknown> } | { readonly ok: false; readonly reason: string };

/** `update_equipment` params for the fields whose text differs from `initial`. */
export function buildEquipmentUpdate(elementId: string, initial: EquipmentEditValues, values: EquipmentEditValues): EquipmentEdit {
  const reader = new FieldReader(values);
  const changed = (...keys: EquipmentEditKey[]): boolean => keys.some((key) => values[key] !== initial[key]);
  const changes: Record<string, unknown> = {};
  if (changed('mark')) changes['mark'] = reader.text('mark');
  if (changed('name')) changes['name'] = reader.text('name');
  if (changed('x', 'y')) changes['location'] = [reader.number('x'), reader.number('y')];
  if (changed('length', 'width', 'height')) {
    changes['size'] = [reader.number('length'), reader.number('width'), reader.number('height')];
  }
  if (changed('angle')) changes['angle'] = toRadians(reader.number('angle'));
  if (changed('clearance')) changes['clearance'] = reader.number('clearance');
  if (changed('weight')) changes['weight'] = reader.number('weight');
  if (changed('levelId')) changes['levelId'] = reader.text('levelId');
  if (changed('shape')) changes['shape'] = reader.text('shape');
  if (Object.keys(changes).length === 0) return { ok: false, reason: 'Nothing changed.' };
  const outcome = result(reader, 'update_equipment', { elementId, ...changes });
  return outcome.ok ? { ok: true, params: outcome.params } : outcome;
}
