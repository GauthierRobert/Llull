/**
 * Plant 03 EQP-PID-FU2: reinforcing pads on nozzles. A pad is stored on the nozzle record, drawn (flat ring on the nozzle axis), added to the nozzle
 * mass, listed in the data sheet and validated on load. Its area (A5) is NOT credited by nozzle_reinforcement: the A5 formula has no cited source in
 * validation/sources.md, so the check refuses the credit by name and the UG-37 numbers stay those of the unpadded nozzle.
 * Hand numbers: DN200 neck 219.1 x 8.18 mm, pad OD 400 x 10: annulus pi (200^2 - 109.55^2) = 8.7727e4 mm2 x 10 mm = 877 270 mm3 = 6.886 kg at 7850 kg/m3.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument, RevolutionEntity } from '@core/model/types';
import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { buildingErrors } from '@aec/building/validate';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { mmDocument } from './equipmentFixtures';

const PAD = { outsideDiameter: 400, thickness: 10 };
const nozzle = (extra: object = {}): object => ({
  equipment: 'V-1',
  mark: 'N200',
  dn: 200,
  rating: 'CL150',
  facing: 'RF',
  location: { on: 'shell', elevation: 1500, orientationDeg: 0 },
  projection: 800,
  ...extra,
});

const vessel = (): CadDocument =>
  apply(mmDocument(), 'add_vessel', {
    tag: 'V-1',
    orientation: 'vertical',
    location: [0, 0],
    insideDiameter: 1000,
    tangentLength: 3000,
    heads: { top: { type: 'ellipsoidal', ratio: 2 }, bottom: { type: 'ellipsoidal', ratio: 2 } },
    shellThickness: 12,
    headThickness: 12,
    corrosionAllowance: 3,
    support: { type: 'none' },
    design: {
      pressure: { value: 1.5, unit: 'MPa' },
      allowableStress: { value: 138, unit: 'MPa', source: 'hand example' },
      jointEfficiency: { shell: 1, heads: 1 },
      material: 'SA-516-70',
      density: { value: 7850, unit: 'kg/m3' },
    },
  });

interface Row {
  mark: string;
  a1Mm2: number;
  a2Mm2: number;
  availableAreaMm2: number;
  requiredAreaMm2: number;
  status: string;
  inputs: Record<string, number>;
  notChecked: string[];
}
const reinforcement = (doc: CadDocument): Row =>
  data<{ nozzles: Row[] }>(doc, 'nozzle_reinforcement', { equipment: 'V-1' }).nozzles[0] as Row;
const nozzleKg = (doc: CadDocument): number =>
  data<{ breakdown: Array<{ part: string; kg: number; method: string }> }>(doc, 'equipment_weights', {
    equipment: 'V-1',
    include: ['body', 'nozzles'],
  }).breakdown.find((part) => part.part === 'nozzle N200')?.kg ?? NaN;

describe('nozzle pad: add_nozzle / update_nozzle', () => {
  const plain = apply(vessel(), 'add_nozzle', nozzle());
  const padded = apply(vessel(), 'add_nozzle', nozzle({ pad: PAD }));

  it('stores the pad on the record and draws it as a wider ring at the foot of the neck', () => {
    const element = Object.values((padded.building as BuildingModel).elements).find(
      (item): item is EquipmentElement => item.category === 'equipment',
    );
    expect(element?.plant?.nozzles[0]?.pad).toEqual(PAD);
    const entity = padded.entities[`${element?.id}:nozzle-N200`] as RevolutionEntity;
    const radii = entity.profile.map((point) => point[0]);
    expect(Math.max(...radii.slice(0, 4))).toBe(200);
    expect(entity.profile.some((point) => point[0] === 200 && point[1] === 10)).toBe(true);
    const plainElement = Object.values((plain.building as BuildingModel).elements).find((item) => item.category === 'equipment');
    expect((plain.entities[`${plainElement?.id}:nozzle-N200`] as RevolutionEntity).profile).toHaveLength(6);
    expect(entity.profile).toHaveLength(8);
  });

  it('adds the flat pad annulus to the nozzle mass (pi (200^2 - 109.55^2) x 10 mm3 at 7850 kg/m3)', () => {
    const area = Math.PI * (200 * 200 - 109.55 * 109.55);
    expect(nozzleKg(padded) - nozzleKg(plain)).toBeCloseTo((area * 10 * 7850) / 1e9, 6);
  });

  it('is listed in the nozzle schedule (JSON rows and CSV columns); a nozzle without a pad has empty cells', () => {
    const result = data<{ nozzles: Array<Record<string, unknown>> }>(padded, 'equipment_datasheet', { equipment: 'V-1' });
    expect(result.nozzles[0]?.['pad']).toEqual({ outsideDiameterMm: 400, thicknessMm: 10 });
    const csv = data<{ text: string }>(padded, 'equipment_datasheet', { equipment: 'V-1', format: 'csv', table: 'nozzles' }).text.split(
      '\n',
    );
    expect(csv[0]).toContain('padOutsideDiameterMm,padThicknessMm');
    expect(csv[1]?.split(',').slice(-2)).toEqual(['400', '10']);
    const none = data<{ text: string }>(plain, 'equipment_datasheet', { equipment: 'V-1', format: 'csv', table: 'nozzles' }).text.split(
      '\n',
    );
    expect(none[1]?.split(',').slice(-2)).toEqual(['', '']);
  });

  it('update_nozzle adds, keeps and removes the pad; pad and removePad together are refused', () => {
    const added = apply(plain, 'update_nozzle', { equipment: 'V-1', mark: 'N200', pad: PAD });
    expect(nozzleKg(added)).toBeCloseTo(nozzleKg(padded), 9);
    const kept = apply(added, 'update_nozzle', { equipment: 'V-1', mark: 'N200', service: 'inlet' });
    expect(nozzleKg(kept)).toBeCloseTo(nozzleKg(padded), 9);
    const removed = apply(kept, 'update_nozzle', { equipment: 'V-1', mark: 'N200', removePad: true });
    expect(nozzleKg(removed)).toBeCloseTo(nozzleKg(plain), 9);
    expectRefusal(added, 'update_nozzle', { equipment: 'V-1', mark: 'N200', pad: PAD, removePad: true }, 'EQP_PARAM_INVALID', 'removePad');
    expectPure(added, () => execute(added, 'update_nozzle', { equipment: 'V-1', mark: 'N200', removePad: true }));
  });

  it.each([
    ['a pad not wider than the neck', { outsideDiameter: 219.1, thickness: 10 }, 'pad.outsideDiameter'],
    ['a pad as thick as the neck is long', { outsideDiameter: 400, thickness: 900 }, 'pad.thickness'],
  ])('refuses %s', (_name, pad, path) => {
    expectRefusal(vessel(), 'add_nozzle', nozzle({ pad }), 'EQP_PARAM_INVALID', path);
  });
});

describe('nozzle pad: reinforcement is not credited, by name', () => {
  const plain = reinforcement(apply(vessel(), 'add_nozzle', nozzle()));
  const padded = reinforcement(apply(vessel(), 'add_nozzle', nozzle({ pad: PAD })));

  it('the areas and the status are those of the unpadded nozzle; the pad is reported as not credited and its size is an input', () => {
    expect(padded.a1Mm2).toBeCloseTo(plain.a1Mm2, 9);
    expect(padded.a2Mm2).toBeCloseTo(plain.a2Mm2, 9);
    expect(padded.availableAreaMm2).toBeCloseTo(plain.availableAreaMm2, 9);
    expect(padded.status).toBe(plain.status);
    expect(padded.notChecked[0]).toContain('NOT credited');
    expect(padded.notChecked[0]).toContain('A5');
    expect(padded.inputs['padOutsideDiameterMm']).toBe(400);
    expect(padded.inputs['padThicknessMm']).toBe(10);
    expect(plain.notChecked.join(';')).not.toContain('NOT credited');
  });

  it('UG-41 weld paths and UG-36 spacing are refused by name (no cited source)', () => {
    const text = padded.notChecked.join(';');
    expect(text).toContain('UG-41');
    expect(text).toContain('refused by name');
    expect(text).toContain('UG-36(c)(2)');
  });
});

describe('nozzle pad: load validation', () => {
  const corrupt = (pad: unknown): string[] => {
    const doc = apply(vessel(), 'add_nozzle', nozzle({ pad: PAD }));
    const broken = structuredClone(doc.building);
    const element = Object.values(broken?.elements ?? {}).find((item) => item.category === 'equipment') as unknown as {
      plant: { nozzles: Array<Record<string, unknown>> };
    };
    element.plant.nozzles[0] = { ...element.plant.nozzles[0], pad };
    return buildingErrors(broken);
  };

  it('accepts the stored pad, names a non-positive size and a pad no wider than the neck', () => {
    expect(corrupt(PAD)).toEqual([]);
    expect(corrupt({ outsideDiameter: 0, thickness: 10 }).join(';')).toContain('pad needs outsideDiameter and thickness > 0');
    expect(corrupt('big').join(';')).toContain('pad needs outsideDiameter and thickness > 0');
    expect(corrupt({ outsideDiameter: 200, thickness: 10 }).join(';')).toContain('pad.outsideDiameter must exceed neckOutsideDiameter');
  });
});
