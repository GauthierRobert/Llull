/**
 * Plant 03 EQP-PID-FU2: vertical, kettle (TEMA K), cross-flow (TEMA X) exchangers and front head D. Oracles are closed forms written here (frustum
 * volume, moment balance, orientation invariance of the masses); no number comes from running llull.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { bemParams, mmDocument } from './equipmentFixtures';

const equipmentOf = (doc: CadDocument, tag: string): EquipmentElement => {
  const found = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === tag);
  if (found?.category !== 'equipment') throw new Error(`no equipment ${tag}`);
  return found;
};
const partsOf = (doc: CadDocument): string[] => Object.keys(doc.entities).map((id) => id.split(':')[1] as string);
const weightsOf = (doc: CadDocument, equipment: string): { body: { emptyKg: number; operatingKg: number; testKg: number } } =>
  data(doc, 'equipment_weights', { equipment });
const volumeOf = (doc: CadDocument, equipment: string, side: 'shell' | 'tube'): number =>
  data<{ totalVolumeM3: number }>(doc, 'vessel_volume', { equipment, side }).totalVolumeM3;
const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

const vertical = { ...bemParams, tag: 'E-401', orientation: 'vertical', support: { type: 'skirt', height: 1000 } };
const kettle = {
  ...bemParams,
  tag: 'E-402',
  temaType: 'AKU',
  rearChannel: undefined,
  support: undefined,
  kettle: { enlargedInsideDiameter: 900, enlargedLength: 2000, transitionLength: 300, enlargedThickness: 10, weirHeight: 500 },
};

describe('vertical exchanger', () => {
  const doc = apply(mmDocument(), 'add_heat_exchanger', vertical);

  it('stores the orientation, derives a skirt and keeps the masses and volumes of the horizontal one (orientation invariance)', () => {
    expect(equipmentOf(doc, 'E-401').plant?.template).toMatchObject({ orientation: 'vertical', support: { type: 'skirt', height: 1000 } });
    expect(partsOf(doc)).toEqual(expect.arrayContaining(['shell', 'front-bonnet', 'rear-bonnet', 'skirt']));
    const horizontal = apply(mmDocument(), 'add_heat_exchanger', bemParams);
    expect(weightsOf(doc, 'E-401').body.emptyKg).toBeCloseTo(weightsOf(horizontal, 'E-301').body.emptyKg, 9);
    expect(volumeOf(doc, 'E-401', 'shell')).toBeCloseTo(volumeOf(horizontal, 'E-301', 'shell'), 12);
  });

  it('stands on the support: size is [D, D, top of the rear bonnet], the bottom tangent line is at the skirt height', () => {
    const [width, depth, top] = equipmentOf(doc, 'E-401').size;
    // tangent to tangent 300 + 50 + 4777 + 50 + 300, bonnet outside apex 150 + 8 above the rear tangent
    expect(top).toBeCloseTo(1000 + 5477 + 158, 6);
    expect(width).toBeCloseTo(2 * (300 + 8 + 8), 6);
    expect(depth).toBeCloseTo(width, 9);
    expect(equipmentOf(doc, 'E-401').shape).toBe('vertical_vessel');
  });

  it('shell nozzles take station -> height and north_cw angle; the centre of gravity of the symmetric BEM is on the axis at mid height', () => {
    const next = apply(doc, 'add_nozzle', {
      equipment: 'E-401',
      mark: 'S1',
      dn: 150,
      rating: 'CL150',
      location: { on: 'shell', station: 400, orientationDeg: 90 },
      projection: 600,
    });
    const ports = data<{ ports: Record<string, { position: number[]; direction: number[] }> }>(next, 'equipment_ports', {
      equipment: 'E-401',
    }).ports;
    // shell starts 300 channel + 50 tubesheet above the bottom tangent line (z 1000)
    expect(ports['E-401:S1']?.position).toEqual([600, 8000, 1000 + 350 + 400]);
    expect(ports['E-401:S1']?.direction).toEqual([1, 0, 0]);
    const cog = data<{ empty: { local: number[] } }>(doc, 'equipment_cog', { equipment: 'E-401' });
    expect(cog.empty.local[0]).toBeCloseTo(0, 8);
    expect(cog.empty.local[1]).toBeCloseTo(0, 8);
    expect(cog.empty.local[2]).toBeCloseTo(1000 + 5477 / 2, 6);
  });

  it('legs: square legs on the pitch circle; none: base elevation is the bottom tangent line', () => {
    const legs = apply(mmDocument(), 'add_heat_exchanger', { ...vertical, support: { type: 'legs', count: 4, height: 800 } });
    expect(partsOf(legs).filter((part) => part.startsWith('leg-'))).toHaveLength(4);
    expect(equipmentOf(legs, 'E-401').plant?.template).toMatchObject({ support: { type: 'legs', count: 4, height: 800 } });
    const none = apply(mmDocument(), 'add_heat_exchanger', { ...vertical, support: { type: 'none', baseElevation: 200 } });
    expect(equipmentOf(none, 'E-401').size[2]).toBeCloseTo(200 + 5477 + 158, 6);
    const ring = apply(mmDocument(), 'add_heat_exchanger', { ...vertical, support: { type: 'skirt', height: 1000, baseRingWidth: 40 } });
    expect(partsOf(ring)).toContain('base-ring');
  });

  it('a removable-bundle vertical exchanger has no zone on the floor side: a skid standing on the floor is no clearance clash (the zone points up, see exchangerReview)', () => {
    const pulled = apply(mmDocument(), 'add_heat_exchanger', { ...vertical, tag: 'E-403', temaType: 'AES', rearChannel: undefined });
    const skid = apply(pulled, 'add_equipment', { name: 'Skid', mark: 'X-1', location: [0, 8000], size: [200, 200, 400], clearance: 0 });
    expect(data<{ clashes: Array<{ kind: string }> }>(skid, 'check_clashes', {}).clashes.some((hit) => hit.kind === 'clearance')).toBe(
      false,
    );
  });

  it('is revised in place through update_equipment_parameters (orientation + support together)', () => {
    const horizontal = apply(mmDocument(), 'add_heat_exchanger', bemParams);
    const revised = apply(horizontal, 'update_equipment_parameters', {
      equipment: 'E-301',
      exchanger: { orientation: 'vertical', support: { type: 'skirt', height: 900 } },
    });
    expect(equipmentOf(revised, 'E-301').plant?.template).toMatchObject({ orientation: 'vertical' });
    expectRefusal(
      horizontal,
      'update_equipment_parameters',
      { equipment: 'E-301', exchanger: { orientation: 'vertical' } },
      'EQP_SUPPORT_INVALID',
      'exchanger.support.type',
    );
  });
});

describe('kettle (TEMA K)', () => {
  const doc = apply(mmDocument(), 'add_heat_exchanger', kettle);

  it('derives the restricted shell, the cone and the enlarged shell; the weir is data', () => {
    expect(partsOf(doc)).toEqual(expect.arrayContaining(['shell', 'kettleTransition', 'kettleShell', 'rear-shell-cover']));
    expect(equipmentOf(doc, 'E-402').plant?.template).toMatchObject({ kettle: { weirHeight: 500, enlargedThickness: 10 } });
  });

  it('shell-side volume is the cylinder + frustum + cylinder minus the tubes plus the 2:1 cover of the enlarged radius (closed forms)', () => {
    const tubes = (300 * Math.PI * 19.05 ** 2) / 4;
    const length = 4877 - 50;
    const straight = length - 2000 - 300;
    const cone = (Math.PI * 300 * (300 ** 2 + 300 * 450 + 450 ** 2)) / 3;
    const expected = Math.PI * 300 ** 2 * straight + cone + Math.PI * 450 ** 2 * 2000 - tubes * length + (Math.PI * 450 ** 3) / 3;
    expect(rel(volumeOf(doc, 'E-402', 'shell') * 1e9, expected)).toBeLessThan(1e-9);
  });

  it('weights are heavier than the plain AEU, the centre of gravity moves toward the enlarged (rear) end, the test water adds both volumes', () => {
    const plain = apply(mmDocument(), 'add_heat_exchanger', { ...kettle, tag: 'E-404', temaType: 'AEU', kettle: undefined });
    expect(weightsOf(doc, 'E-402').body.emptyKg).toBeGreaterThan(weightsOf(plain, 'E-404').body.emptyKg);
    const kettleCog = data<{ empty: { local: number[]; kg: number }; test: { kg: number } }>(doc, 'equipment_cog', { equipment: 'E-402' });
    const plainCog = data<{ empty: { local: number[] } }>(plain, 'equipment_cog', { equipment: 'E-404' });
    expect(kettleCog.empty.local[0]).toBeGreaterThan(plainCog.empty.local[0] as number);
    expect(kettleCog.empty.kg).toBeCloseTo(weightsOf(doc, 'E-402').body.emptyKg, 8);
    expect(kettleCog.test.kg - kettleCog.empty.kg).toBeCloseTo(
      (volumeOf(doc, 'E-402', 'shell') + volumeOf(doc, 'E-402', 'tube')) * 1000,
      6,
    );
  });

  it('a shell nozzle on the enlarged shell sits on its radius: wall 450 + 10, so a projection of 455 is refused and 470 is accepted', () => {
    const at = (projection: number): object => ({
      equipment: 'E-402',
      mark: 'V1',
      dn: 200,
      rating: 'CL150',
      location: { on: 'shell', station: 4000, orientationDeg: 0 },
      projection,
    });
    expectRefusal(doc, 'add_nozzle', at(455), 'EQP_NOZZLE_PROJECTION_TOO_SHORT', 'projection');
    const next = apply(doc, 'add_nozzle', at(600));
    const ports = data<{ ports: Record<string, { position: number[] }> }>(next, 'equipment_ports', { equipment: 'E-402' }).ports;
    expect(ports['E-402:V1']?.position[2]).toBeCloseTo(460 + 600, 6);
    const checked = data<{ checked: unknown[]; issues: Array<{ code: string }> }>(next, 'check_equipment', {});
    expect(checked.checked).toHaveLength(1);
  });

  it('check_equipment judges the enlarged shell with its own diameter and names the thickness it assumed', () => {
    const rated = apply(mmDocument(), 'add_heat_exchanger', {
      ...kettle,
      kettle: { ...kettle.kettle, enlargedThickness: undefined },
      design: {
        shellSide: {
          pressure: { value: 1, unit: 'MPa' },
          temperatureC: 120,
          material: 'SA-516 Gr 70',
          allowableStress: { value: 138, unit: 'MPa', source: 'test' },
          jointEfficiency: { shell: 1, heads: 1 },
        },
      },
    });
    const report = data<{ issues: Array<{ code: string; paths: string[] }> }>(rated, 'check_equipment', {});
    expect(report.issues.some((issue) => issue.paths.includes('kettle.enlargedThickness'))).toBe(true);
  });

  it.each([
    ['vertical kettle', { orientation: 'vertical', support: { type: 'none' } }, 'EQP_EXCHANGER_UNSUPPORTED', 'orientation'],
    ['fixed-tubesheet rear', { temaType: 'AKM', rearChannel: { length: 300 } }, 'EQP_EXCHANGER_UNSUPPORTED', 'temaType.2'],
    ['K without kettle', { kettle: undefined }, 'EQP_PARAM_INVALID', 'kettle'],
    ['kettle on an E shell', { temaType: 'AEU' }, 'EQP_PARAM_INVALID', 'kettle'],
    [
      'enlarged not larger',
      { kettle: { ...kettle.kettle, enlargedInsideDiameter: 600 } },
      'EQP_PARAM_INVALID',
      'kettle.enlargedInsideDiameter',
    ],
    ['weir above the shell', { kettle: { ...kettle.kettle, weirHeight: 900 } }, 'EQP_PARAM_INVALID', 'kettle.weirHeight'],
    ['no restricted cylinder left', { kettle: { ...kettle.kettle, enlargedLength: 4600 } }, 'EQP_PARAM_INVALID', 'kettle.enlargedLength'],
    ['wall not above the allowance', { corrosionAllowance: 10, shellThickness: 12 }, 'EQP_PARAM_INVALID', 'kettle.enlargedThickness'],
  ])('refuses %s by name and leaves the document unchanged', (_name, patch, code, path) => {
    const before = mmDocument();
    const refused = expectRefusal(before, 'add_heat_exchanger', { ...kettle, ...patch }, code, path);
    expect(refused.document).toBe(before);
  });
});

describe('legacy consumers of the new variants: IFC export and the equipment schedule', () => {
  it('a vertical, a kettle and a D exchanger are exported as equipment products and listed with their derived weight', () => {
    let doc = apply(mmDocument(), 'add_heat_exchanger', vertical);
    doc = apply(doc, 'add_heat_exchanger', { ...kettle, location: [5000, 8000] });
    doc = apply(doc, 'add_heat_exchanger', {
      ...bemParams,
      tag: 'E-407',
      temaType: 'DEM',
      location: [10000, 8000],
      frontChannel: { length: 300, thickness: 20, coverThickness: 60 },
    });
    const ifc = data<{ ifc: string; warnings: unknown[] }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00' });
    for (const tag of ['E-401', 'E-402', 'E-407']) expect(ifc.ifc).toContain(tag);
    const schedule = data<{ rows: unknown[][] }>(doc, 'building_schedule', { kind: 'equipment' });
    expect(schedule.rows).toHaveLength(3);
  });
});

describe('cross flow (TEMA X) and front head D', () => {
  const x = { ...bemParams, tag: 'E-405', temaType: 'BXM' };

  it('X is built like an E shell and check_equipment asks for two shell nozzles on opposite sides', () => {
    const doc = apply(mmDocument(), 'add_heat_exchanger', x);
    expect(equipmentOf(doc, 'E-405').plant?.template).toMatchObject({ tema: { shell: 'X' } });
    const missing = data<{ issues: Array<{ code: string }> }>(doc, 'check_equipment', {}).issues;
    expect(missing.map((issue) => issue.code)).toContain('EQP_X_SHELL_NOZZLES');
    const inlet = { equipment: 'E-405', dn: 150, rating: 'CL150', projection: 600 };
    const one = apply(doc, 'add_nozzle', { ...inlet, mark: 'S1', location: { on: 'shell', station: 400, orientationDeg: 0 } });
    expect(data<{ issues: Array<{ code: string }> }>(one, 'check_equipment', {}).issues.map((issue) => issue.code)).toContain(
      'EQP_X_SHELL_NOZZLES',
    );
    const two = apply(one, 'add_nozzle', { ...inlet, mark: 'S2', location: { on: 'shell', station: 400, orientationDeg: 180 } });
    expect(data<{ issues: Array<{ code: string }> }>(two, 'check_equipment', {}).issues.map((issue) => issue.code)).not.toContain(
      'EQP_X_SHELL_NOZZLES',
    );
    const e = apply(mmDocument(), 'add_heat_exchanger', { ...bemParams, tag: 'E-406' });
    expect(weightsOf(doc, 'E-405').body.emptyKg).toBeCloseTo(weightsOf(e, 'E-406').body.emptyKg, 9);
  });

  it('D has a thick flat cover: the cover entity is coverThickness thick and the mass uses it (disc of the outside radius x cover)', () => {
    const d = { ...bemParams, tag: 'E-407', temaType: 'DEM', frontChannel: { length: 300, thickness: 20, coverThickness: 60 } };
    const doc = apply(mmDocument(), 'add_heat_exchanger', d);
    expect(partsOf(doc)).toContain('front-cover');
    const plain = apply(mmDocument(), 'add_heat_exchanger', {
      ...d,
      tag: 'E-408',
      frontChannel: { length: 300, thickness: 20, coverThickness: 20 },
    });
    const extraKg = weightsOf(doc, 'E-407').body.emptyKg - weightsOf(plain, 'E-408').body.emptyKg;
    expect(extraKg).toBeCloseTo(Math.PI * 320 ** 2 * 40 * 1e-9 * 7850, 6);
  });

  it.each([
    [
      'D without a channel wall',
      { temaType: 'DEM', frontChannel: { length: 300, coverThickness: 50 } },
      'EQP_PARAM_INVALID',
      'frontChannel.thickness',
    ],
    [
      'D without a cover thickness',
      { temaType: 'DEM', frontChannel: { length: 300, thickness: 20 } },
      'EQP_PARAM_INVALID',
      'frontChannel.coverThickness',
    ],
    ['a cover on a bonnet', { frontChannel: { length: 300, coverThickness: 20 } }, 'EQP_PARAM_INVALID', 'frontChannel.coverThickness'],
    ['a vertical exchanger on saddles', { orientation: 'vertical' }, 'EQP_SUPPORT_INVALID', 'support.type'],
    ['a horizontal exchanger on a skirt', { support: { type: 'skirt', height: 500 } }, 'EQP_SUPPORT_INVALID', 'support.type'],
  ])('refuses %s', (_name, patch, code, path) => {
    expectRefusal(mmDocument(), 'add_heat_exchanger', { ...bemParams, ...patch }, code, path);
  });

  it('is pure: the input document is not changed by the new variants', () => {
    const before = mmDocument();
    const snapshot = JSON.stringify(before);
    execute(before, 'add_heat_exchanger', kettle);
    execute(before, 'add_heat_exchanger', vertical);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
