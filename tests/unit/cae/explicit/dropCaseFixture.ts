/** 14 FLL-M5 fixture: the VC-FLL-05 vehicle, a 200 x 200 x 50 mm box of 1.115 kg (density 557.5 kg/m^3, synthetic) floating 100 mm above z = 0. */
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const must = (doc: CadDocument, name: string, params: Record<string, unknown>): ReturnType<typeof execute> => {
  const result = execute(doc, name, params);
  if (result.error !== undefined) throw new Error(`${name}: ${result.summary}`);
  return result;
};

export interface DropVehicle {
  readonly doc: CadDocument;
  readonly boxId: string;
}

/** The vehicle box (mm document) with its material; `density` in g/mm^3. */
export function dropVehicle(density = 0.0005575): DropVehicle {
  let doc = must(createEmptyDocument(), 'set_units', { units: 'mm' }).document;
  const box = must(doc, 'add_box', { size: [200, 200, 50], position: [0, 0, 100], anchor: 'min' });
  doc = must(box.document, 'create_material', { name: 'vehicle', density, color: '#9aa0a6', metalness: 0, roughness: 0.6 }).document;
  const source = { citation: 'synthetic test input of the 14 FLL-M5 drop case (not a material claim)' };
  doc = must(doc, 'add_material_model', {
    material: 'vehicle',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 2000, unit: 'MPa' }, nu: { value: 0.35, unit: '1' } },
    basis: 'company',
    source,
  }).document;
  doc = must(doc, 'define_constitutive_set', { material: 'vehicle', set: { id: 'set', elastic: 'elastic' }, makeDefault: true }).document;
  const boxId = box.affected[0] ?? '';
  return { doc: must(doc, 'assign_material', { materialName: 'vehicle', entityIds: [boxId] }).document, boxId };
}

/** `create_drop_case` params of the 0.5 m level drop of `boxId`. */
export const levelDrop = (boxId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  partIds: [boxId],
  heightM: 0.5,
  orientation: 'level',
  endTime: { value: 10, unit: 'ms' },
  mesh: { kind: 'structured_hex', size: 25 },
  ...overrides,
});
