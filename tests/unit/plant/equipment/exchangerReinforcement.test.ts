/**
 * Plant 03 EQP-FU2: nozzle_reinforcement for exchangers (UG-37 on the shell with design.shellSide, on a channel with design.tubeSide). Hand calculation,
 * not produced by llull: shell D 600, t 8, CA 3 (R 303, t 5), P 1.5 MPa, S 138 MPa, E1 = 1, f_r = 1:
 *   t_r = P R / (S - 0.6 P) = 454.5 / 137.1 = 3.3150985
 *   DN150 (168.3 x 7.11): d = 168.3 - 14.22 + 6 = 160.08, t_n = 4.11, t_rn = 1.5 x 80.04 / 137.1 = 0.8757330
 *     A = d t_r = 530.6914, A1 = d (t - t_r) = 160.08 x 1.6849015 = 269.72, A2 = 5 (t_n - t_rn) min(t, t_n) = 5 x 3.234267 x 4.11 = 66.4640
 *     available 336.18 < A -> fail (d = 160.08 > 89)
 * Channel 12 mm (CA 3: t 9), tube side P 0.6 MPa, S 138 MPa: t_r = 0.6 x 303 / (138 - 0.36) = 1.3209
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { elementsOf, getBuilding } from '@aec/building/model';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { bemParams, mmDocument } from './equipmentFixtures';

const stress = { value: 138, unit: 'MPa', source: 'hand example' };
const exchanger = (design: object = {}, extra: object = {}): CadDocument => {
  const doc = apply(mmDocument(), 'add_heat_exchanger', {
    ...bemParams,
    corrosionAllowance: 3,
    frontChannel: { length: 300, thickness: 12 },
    rearChannel: { length: 300, thickness: 12 },
    design: {
      shellSide: { pressure: { value: 1.5, unit: 'MPa' }, allowableStress: stress, ...design },
      tubeSide: { pressure: { value: 0.6, unit: 'MPa' }, allowableStress: stress },
    },
    ...extra,
  });
  const shell = apply(doc, 'add_nozzle', {
    equipment: 'E-301',
    mark: 'S1',
    dn: 150,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'shell', station: 400, orientationDeg: 0 },
    projection: 600,
  });
  return apply(shell, 'add_nozzle', {
    equipment: 'E-301',
    mark: 'T1',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'channel', channel: 'front', station: 150, orientationDeg: 180 },
    projection: 550,
  });
};

interface Row {
  mark: string;
  on: string;
  status: string;
  requiredAreaMm2: number;
  a1Mm2: number;
  a2Mm2: number;
  availableAreaMm2: number;
  requiredShellThicknessMm: number;
  requiredNeckThicknessMm: number;
  inputs: Record<string, number | string>;
}
interface Report {
  nozzles: Row[];
  notCovered: Array<{ mark: string; code: string; paths: string[] }>;
  sides: Record<string, { pressureMPa: number; stressMPa: number }>;
  status: string;
}
const query = (doc: CadDocument, extra: object = {}): Report => data<Report>(doc, 'nozzle_reinforcement', { equipment: 'E-301', ...extra });
const row = (report: Report, mark: string): Row => report.nozzles.find((entry) => entry.mark === mark) as Row;

describe('nozzle_reinforcement: exchangers', () => {
  it('a DN150 shell nozzle on the 8 mm shell (CA 3) with the shell-side design: t_r 3.3150985, A 530.69, A1 269.72, A2 66.46, available 336.18 -> fail', () => {
    const report = query(exchanger(), { mark: 'S1' });
    const n = row(report, 'S1');
    expect(n.on).toBe('shell');
    expect(n.inputs['openingDiameterMm']).toBeCloseTo(160.08, 9);
    expect(n.requiredShellThicknessMm).toBeCloseTo(454.5 / 137.1, 9);
    expect(n.requiredNeckThicknessMm).toBeCloseTo((1.5 * 80.04) / 137.1, 9);
    expect(n.requiredAreaMm2).toBeCloseTo(160.08 * (454.5 / 137.1), 9);
    expect(n.a1Mm2).toBeCloseTo(160.08 * (5 - 454.5 / 137.1), 9);
    expect(n.a2Mm2).toBeCloseTo(5 * (4.11 - (1.5 * 80.04) / 137.1) * 4.11, 9);
    expect(n.availableAreaMm2).toBeCloseTo(160.08 * (5 - 454.5 / 137.1) + 5 * (4.11 - (1.5 * 80.04) / 137.1) * 4.11, 9);
    expect(n.availableAreaMm2).toBeCloseTo(336.18, 2);
    expect(n.status).toBe('fail');
    expect(n.inputs['side']).toBe('shellSide');
    expect(report.sides['shellSide']).toEqual({ pressureMPa: 1.5, stressMPa: 138 });
  });

  it('a channel nozzle uses the TUBE side design and the channel wall (12 mm, CA 3): t_r = 0.6 x 303 / (138 - 0.36), margin from the 9 mm wall', () => {
    const report = query(exchanger(), { mark: 'T1' });
    const n = row(report, 'T1');
    expect(n.on).toBe('channel');
    expect(n.inputs['side']).toBe('tubeSide');
    expect(n.requiredShellThicknessMm).toBeCloseTo(181.8 / 137.64, 9);
    expect(n.inputs['wallCorrodedMm']).toBeCloseTo(9, 9);
    expect(n.a1Mm2).toBeCloseTo((n.inputs['openingDiameterMm'] as number) * (9 - 181.8 / 137.64), 7);
    expect(report.sides['tubeSide']).toEqual({ pressureMPa: 0.6, stressMPa: 138 });
  });

  it('with no mark every shell and channel nozzle is reported; a free nozzle is listed under notCovered, never passed', () => {
    const doc = apply(exchanger(), 'add_nozzle', {
      equipment: 'E-301',
      mark: 'F1',
      dn: 50,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'free', position: [0, 0, 1500], direction: [0, 0, 1] },
      projection: 200,
    });
    const report = query(doc);
    expect(report.nozzles.map((entry) => entry.mark)).toEqual(['S1', 'T1']);
    expect(report.notCovered).toEqual([expect.objectContaining({ mark: 'F1', code: 'EQP_PARAM_INVALID' })]);
    expect(report.status).toBe('fail');
  });

  it('a side without design data refuses only its own nozzles with the side path; the other side is still computed', () => {
    const doc = exchanger(
      {},
      {
        design: {
          shellSide: { pressure: { value: 1.5, unit: 'MPa' }, allowableStress: stress },
          tubeSide: { pressure: { value: 0.6, unit: 'MPa' } },
        },
      },
    );
    const report = query(doc);
    expect(report.nozzles.map((entry) => entry.mark)).toEqual(['S1']);
    expect(report.notCovered).toEqual([
      expect.objectContaining({ mark: 'T1', code: 'EQP_ALLOWABLE_MISSING', paths: ['design.tubeSide.allowableStress'] }),
    ]);
  });

  it('asking for a mark that cannot be judged is refused as a whole (free nozzle, EQP_PARAM_INVALID)', () => {
    const doc = apply(exchanger(), 'add_nozzle', {
      equipment: 'E-301',
      mark: 'F1',
      dn: 50,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'free', position: [0, 0, 1500], direction: [0, 0, 1] },
      projection: 200,
    });
    expectRefusal(doc, 'nozzle_reinforcement', { equipment: 'E-301', mark: 'F1' }, 'EQP_PARAM_INVALID', 'nozzles.F1.location.on');
    expectRefusal(doc, 'nozzle_reinforcement', { equipment: 'E-301', mark: 'N9' }, 'EQP_NOZZLE_NOT_FOUND', 'mark');
  });

  it('a tank is refused with the API 650 reason; a pressure override changes the shell requirement (what-if 3 MPa)', () => {
    const tank = apply(mmDocument(), 'add_storage_tank', {
      tag: 'T-1',
      standard: 'api_650',
      location: [0, 0],
      diameter: 10000,
      shellHeight: 4000,
      courses: [2000, 2000],
      courseThicknesses: [8, 8],
      roof: { type: 'flat' },
      bottom: { type: 'flat', annularPlate: false },
      design: { specificGravity: 1, designLiquidLevel: 3000, material: 'A36M', corrosionAllowance: 1 },
    });
    const refused = expectRefusal(tank, 'nozzle_reinforcement', { equipment: 'T-1' }, 'EQP_NOT_PARAMETRIC', 'equipment');
    expect(refused.summary).toContain('API 650');
    const high = query(exchanger(), { mark: 'S1', pressure: { value: 3, unit: 'MPa' } });
    expect(row(high, 'S1').requiredShellThicknessMm).toBeCloseTo((3 * 303) / (138 - 1.8), 9);
  });

  it('a rear-channel nozzle on an exchanger with no rear channel is refused EQP_PARAM_INVALID (nozzles.<mark>.location.channel)', () => {
    const base = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      temaType: 'BEU',
      rearChannel: undefined,
      corrosionAllowance: 3,
    });
    const building = getBuilding(base);
    const element = elementsOf(building, 'equipment')[0] as EquipmentElement;
    const nozzle = {
      mark: 'R1',
      dn: 100,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'channel', channel: 'rear', station: 100, orientationDeg: 0 },
      projection: 500,
      neckOutsideDiameter: 114.3,
      neckWall: 6.02,
      flange: { outsideDiameter: 230, thickness: 24, placeholder: false, unverified: false },
    };
    const plant = { ...(element.plant as NonNullable<EquipmentElement['plant']>), nozzles: [nozzle] };
    const doc = {
      ...base,
      building: { ...building, elements: { ...building.elements, [element.id]: { ...element, plant } } },
    } as CadDocument;
    expectRefusal(doc, 'nozzle_reinforcement', { equipment: 'E-301', mark: 'R1' }, 'EQP_PARAM_INVALID', 'nozzles.R1.location.channel');
  });

  it('is a query: the document is unchanged', () => {
    const doc = exchanger();
    const result = execute(doc, 'nozzle_reinforcement', { equipment: 'E-301' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});
