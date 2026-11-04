/**
 * Plant 03 EQP-FU: nozzle_reinforcement (ASME VIII-1 UG-37 area replacement). The oracle is a hand calculation (not produced by llull):
 * D 1000, t 12 (CA 3), P 1.5 MPa, S 138 MPa, E1 = 1, f_r = 1, DN200 neck 219.1 x 8.18, DN150 neck 168.3 x 7.11.
 *   R = 503, t = 9, t_r = P R / (S - 0.6 P) = 754.5 / 137.1 = 5.503282, excess t - t_r = 3.496718
 *   DN200: d = 219.1 - 16.36 + 6 = 208.74, t_n = 5.18, t_rn = 1.5 x 104.37 / 137.1 = 1.141904
 *     A = d t_r = 1148.7551, A1 = d (t - t_r) = 729.9049, A2 = 5 (t_n - t_rn) min(t, t_n) = 5 x 4.038096 x 5.18 = 104.5867, available 834.4916
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { mmDocument } from './equipmentFixtures';

const nozzle = (mark: string, dn: number, location: unknown, projection: number): object => ({
  equipment: 'V-1',
  mark,
  dn,
  rating: 'CL150',
  facing: 'RF',
  location,
  projection,
});

const vessel = (shell: number, withStress = true): CadDocument => {
  const doc = apply(mmDocument(), 'add_vessel', {
    tag: 'V-1',
    orientation: 'vertical',
    location: [0, 0],
    insideDiameter: 1000,
    tangentLength: 3000,
    heads: { top: { type: 'ellipsoidal', ratio: 2 }, bottom: { type: 'ellipsoidal', ratio: 2 } },
    shellThickness: shell,
    headThickness: 12,
    corrosionAllowance: 3,
    support: { type: 'none' },
    design: {
      pressure: { value: 1.5, unit: 'MPa' },
      ...(withStress ? { allowableStress: { value: 138, unit: 'MPa', source: 'hand example' } } : {}),
      jointEfficiency: { shell: 1, heads: 1 },
    },
  });
  const first = apply(doc, 'add_nozzle', nozzle('N200', 200, { on: 'shell', elevation: 1500, orientationDeg: 0 }, 800));
  return apply(first, 'add_nozzle', nozzle('N150', 150, { on: 'shell', elevation: 2200, orientationDeg: 180 }, 800));
};

interface Row {
  mark: string;
  on: string;
  status: string;
  exempt: boolean;
  requiredAreaMm2: number;
  a1Mm2: number;
  a2Mm2: number;
  a41Mm2: number;
  availableAreaMm2: number;
  marginMm2: number;
  requiredShellThicknessMm: number;
  requiredNeckThicknessMm: number;
  inputs: Record<string, number>;
}
interface Report {
  nozzles: Row[];
  notCovered: Array<{ mark: string; code: string }>;
  failed: string[];
  status: string;
  reviewRequired: boolean;
}
const query = (doc: CadDocument, extra: object = {}): Report => data<Report>(doc, 'nozzle_reinforcement', { equipment: 'V-1', ...extra });
const row = (report: Report, mark: string): Row => report.nozzles.find((entry) => entry.mark === mark) as Row;

describe('nozzle_reinforcement: UG-37 hand calculation', () => {
  it('a 12 mm shell (9 mm corroded) with the DN200 nozzle: A 1148.755, A1 729.905, A2 104.587, available 834.492 -> fail', () => {
    const report = query(vessel(12), { mark: 'N200' });
    const n = row(report, 'N200');
    expect(n.inputs['openingDiameterMm']).toBeCloseTo(208.74, 9);
    expect(n.requiredShellThicknessMm).toBeCloseTo(5.503282, 6);
    expect(n.requiredNeckThicknessMm).toBeCloseTo(1.141904, 6);
    expect(n.requiredAreaMm2).toBeCloseTo(1148.7551, 3);
    expect(n.a1Mm2).toBeCloseTo(729.9049, 3);
    expect(n.a2Mm2).toBeCloseTo(104.5867, 3);
    expect(n.a41Mm2).toBe(0);
    expect(n.availableAreaMm2).toBeCloseTo(834.4916, 3);
    expect(n.marginMm2).toBeCloseTo(834.4916 - 1148.7551, 3);
    expect(n.status).toBe('fail');
    expect(report.failed).toEqual(['N200']);
    expect(report.status).toBe('fail');
    expect(report.reviewRequired).toBe(true);
  });

  it('a 20 mm shell (17 mm corroded): excess 11.496718, A1 = 2399.825, available 2504.412 against 1148.755 -> pass_with_review (margin 1355.657)', () => {
    const n = row(query(vessel(20)), 'N200');
    expect(n.a1Mm2).toBeCloseTo(2399.8249, 3);
    expect(n.a2Mm2).toBeCloseTo(104.5867, 3);
    expect(n.availableAreaMm2).toBeCloseTo(2504.4116, 3);
    expect(n.marginMm2).toBeCloseTo(1355.6565, 3);
    expect(n.status).toBe('pass_with_review');
  });

  it('DN150 on the 12 mm shell: d 160.08, A 880.965, A1 559.755, A2 66.465 -> fail; every nozzle is reported when no mark is given', () => {
    const report = query(vessel(12));
    expect(report.nozzles.map((entry) => entry.mark)).toEqual(['N200', 'N150']);
    const n = row(report, 'N150');
    expect(n.inputs['openingDiameterMm']).toBeCloseTo(160.08, 9);
    expect(n.requiredAreaMm2).toBeCloseTo(880.9654, 3);
    expect(n.a1Mm2).toBeCloseTo(559.7547, 3);
    expect(n.a2Mm2).toBeCloseTo(66.4646, 3);
    expect(n.status).toBe('fail');
  });

  it('a head nozzle on a 2:1 head uses the sphere K1 D = 0.9 D: t_r = 1.5 x 905.4 / (2 x 138 - 0.3) = 4.926007, A 1028.255, available 954.992 -> fail', () => {
    const doc = apply(vessel(12), 'add_nozzle', nozzle('H1', 200, { on: 'head', head: 'top', radialOffset: 0, orientationDeg: 0 }, 700));
    const n = row(query(doc, { mark: 'H1' }), 'H1');
    expect(n.on).toBe('head');
    expect(n.requiredShellThicknessMm).toBeCloseTo(4.9260065, 6);
    expect(n.requiredAreaMm2).toBeCloseTo(1028.2546, 3);
    expect(n.a1Mm2).toBeCloseTo(850.4054, 3);
    expect(n.availableAreaMm2).toBeCloseTo(954.992, 2);
    expect(n.status).toBe('fail');
  });

  it('a small opening (d <= 60 mm for t > 10 mm) that lacks area is exempt (UG-36(c)(3)); a free nozzle and a head opening outside the central 80 % are listed, not checked', () => {
    let doc = apply(vessel(12), 'add_nozzle', nozzle('N50', 50, { on: 'shell', elevation: 800, orientationDeg: 90 }, 700));
    doc = apply(doc, 'add_nozzle', nozzle('F1', 50, { on: 'free', position: [0, 0, 100], direction: [0, 0, 1] }, 200));
    doc = apply(doc, 'add_nozzle', nozzle('H2', 200, { on: 'head', head: 'top', radialOffset: 350, orientationDeg: 0 }, 700));
    const report = query(doc);
    const small = row(report, 'N50');
    expect(small.inputs['openingDiameterMm']).toBeCloseTo(58.48, 9);
    expect(small.availableAreaMm2).toBeLessThan(small.requiredAreaMm2);
    expect(small.exempt).toBe(true);
    expect(small.status).toBe('exempt');
    expect(report.failed).not.toContain('N50');
    expect(Object.fromEntries(report.notCovered.map((entry) => [entry.mark, entry.code]))).toEqual({
      H2: 'EQP_HEAD_NOT_COVERED',
      F1: 'EQP_PARAM_INVALID',
    });
  });

  it('a neck of another material (S_n = 69 MPa, f_r = 0.5) adds 2 t_n t_r (1 - f_r) to the requirement and shrinks A1', () => {
    const n = row(query(vessel(20), { mark: 'N200', nozzleAllowableStress: { value: 69, unit: 'MPa' } }), 'N200');
    const tn = 5.18;
    const tr = 5.503282;
    const d = 208.74;
    expect(n.requiredAreaMm2).toBeCloseTo(d * tr + 2 * tn * tr * 0.5, 3);
    expect(n.a1Mm2).toBeCloseTo(d * (17 - tr) - 2 * tn * (17 - tr) * 0.5, 3);
    expect(n.inputs['fr']).toBe(0.5);
  });

  it('is a query: the document is unchanged', () => {
    const doc = vessel(12);
    const result = execute(doc, 'nozzle_reinforcement', { equipment: 'V-1' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});

describe('nozzle_reinforcement: refusals', () => {
  const freeNozzle = apply(vessel(12), 'add_nozzle', nozzle('F1', 50, { on: 'free', position: [0, 0, 100], direction: [0, 0, 1] }, 200));
  it.each([
    ['unknown equipment', vessel(12), { equipment: 'V-9' }, 'EQP_NOT_FOUND', 'equipment'],
    ['unknown mark', vessel(12), { equipment: 'V-1', mark: 'N9' }, 'EQP_NOZZLE_NOT_FOUND', 'mark'],
    ['no allowable stress (never defaulted)', vessel(12, false), { equipment: 'V-1' }, 'EQP_ALLOWABLE_MISSING', 'design.allowableStress'],
    ['a free nozzle asked by mark', freeNozzle, { equipment: 'V-1', mark: 'F1' }, 'EQP_PARAM_INVALID', 'nozzles.F1.location.on'],
  ])('%s', (_name, doc, params, code, path) => {
    expectRefusal(doc, 'nozzle_reinforcement', params, code, path);
  });
});
