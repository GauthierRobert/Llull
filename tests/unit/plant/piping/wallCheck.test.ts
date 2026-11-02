/** Plant 01 PSC M4: `pipe_wall_check` (VC-PSC-11): B31.3 eq. (3a), schedule selection, validity gates. Expected values come from the pack oracle file. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { pressureDesignWall } from '@aec/plant/catalog/wallDesign';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { packJson } from './packData';

interface Published {
  odMm: number;
  pressurePsi: number;
  allowableStressPsi: number;
  jointFactorE: number;
  weldStrengthW: number;
  coefficientY: number;
  corrosionAllowanceMm: number;
  millTolerance: number;
  pressureThicknessMm: number;
  minimumThicknessMm: number;
  requiredNominalMm: number;
  selectedSchedule: string;
  selectedWallMm: number;
  insufficientSchedule: string;
}
const oracle = packJson<{ wallB313: { published: Published[]; derived: Array<Record<string, number | string>> } }>(
  'psc_m4_oracles.json',
).wallB313;
const reference = oracle.published[0] as Published;
const doc = createEmptyDocument();

const nps4 = {
  nps: 4,
  pressure: { value: reference.pressurePsi, unit: 'psi' },
  allowableStress: { value: reference.allowableStressPsi, unit: 'psi' },
  jointFactorE: reference.jointFactorE,
  weldStrengthW: reference.weldStrengthW,
  coefficientY: reference.coefficientY,
  corrosionAllowance: { value: reference.corrosionAllowanceMm, unit: 'mm' },
  millTolerance: reference.millTolerance,
};
type Wall = Record<string, unknown> & { candidates: Array<{ schedule: string }>; provenance: { inputs: Record<string, number> } };
const check = (over: Record<string, unknown> = {}): Wall => data<Wall>(doc, 'pipe_wall_check', { ...nps4, ...over });
const near = (actual: unknown, expected: number, tolerance: number): void =>
  expect(Math.abs((actual as number) - expected), `${String(actual)} vs ${expected}`).toBeLessThanOrEqual(tolerance);

describe('pipe_wall_check, the published case (VC-PSC-11)', () => {
  it('computes t, tm and the required nominal wall of the S18 worked example and picks Sch 80', () => {
    const wall = check();
    near(wall['pressureThicknessMm'], reference.pressureThicknessMm, 5e-4);
    near(wall['minimumThicknessMm'], reference.minimumThicknessMm, 5e-4);
    near(wall['requiredNominalMm'], reference.requiredNominalMm, 1e-3);
    expect(wall['selectedSchedule']).toBe(reference.selectedSchedule);
    expect(wall['selectedWallMm']).toBe(reference.selectedWallMm);
    near(wall['marginMm'], reference.selectedWallMm - reference.requiredNominalMm, 1e-3);
    expect(wall['reviewRequired']).toBe(true);
    expect(wall['verified']).toBe(true);
    expect(wall.candidates[0]?.schedule).toBe('80');
    expect(wall['outsideDiameterMm']).toBe(114.3);
  });

  it('refuses Sch 40 with PSC_WALL_INSUFFICIENT and names the lightest sufficient schedule in the detail', () => {
    const result = expectRefusal(
      doc,
      'pipe_wall_check',
      { ...nps4, schedule: reference.insufficientSchedule },
      'PSC_WALL_INSUFFICIENT',
      'schedule',
    );
    expect(result.error?.detail).toMatchObject({ lightestSchedule: '80', lightestWallMm: 8.56, checkedWallMm: 6.02, reviewRequired: true });
    near(result.error?.detail?.['requiredNominalMm'], reference.requiredNominalMm, 1e-3);
  });

  it('accepts a sufficient named schedule and reports it as chosen, not as the lightest', () => {
    const wall = check({ schedule: '160' });
    expect(wall['selectedSchedule']).toBe('160');
    expect(wall['lightestSchedule']).toBe('80');
  });

  it('gives the same answer for the same pressure in bar, MPa and psi (units are converted, not assumed)', () => {
    const bar = check({
      pressure: { value: reference.pressurePsi * 0.0689475729, unit: 'bar' },
      allowableStress: { value: reference.allowableStressPsi * 0.0689475729 * 0.1, unit: 'MPa' },
    });
    near(bar['pressureThicknessMm'], reference.pressureThicknessMm, 5e-4);
    near(bar.provenance.inputs['pressureMPa'], reference.pressurePsi * 0.00689475729, 1e-9);
  });

  it('takes the corrosion allowance in inches and DN input (DN100 is NPS 4)', () => {
    const wall = check({ nps: undefined, dn: 100, corrosionAllowance: { value: 3 / 25.4, unit: 'in' } });
    near(wall['requiredNominalMm'], reference.requiredNominalMm, 1e-3);
  });

  it('is read-only and pure', () => {
    expectPure(doc, () => execute(doc, 'pipe_wall_check', nps4));
    expect(execute(doc, 'pipe_wall_check', nps4).document).toBe(doc);
  });
});

describe('pipe_wall_check, the formula against its inverse', () => {
  it('returns the design pressure when the computed wall is fed to P = 2 S E W t / (D - 2 Y t)', () => {
    const case1 = oracle.derived.find((entry) => entry['id'] === 'inverse-mawp') as Record<string, number>;
    const outcome = pressureDesignWall({
      outsideDiameterMm: case1['odMm'] as number,
      pressureMPa: case1['pressureMPa'] as number,
      allowableStressMPa: case1['allowableStressMPa'] as number,
      jointFactorE: case1['jointFactorE'] as number,
      weldStrengthW: case1['weldStrengthW'] as number,
      coefficientY: case1['coefficientY'] as number,
      corrosionAllowanceMm: 0,
      millTolerance: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const t = outcome.design.pressureThicknessMm;
    const back =
      (2 * (case1['allowableStressMPa'] as number) * (case1['jointFactorE'] as number) * (case1['weldStrengthW'] as number) * t) /
      ((case1['odMm'] as number) - 2 * (case1['coefficientY'] as number) * t);
    expect(Math.abs(back / (case1['pressureMPa'] as number) - 1)).toBeLessThan(1e-9);
  });
});

describe('pipe_wall_check, validity gates (formula outside its range is refused, never evaluated)', () => {
  it('refuses a missing allowable stress or factor with PSC_ALLOWABLE_MISSING listing every missing name', () => {
    const result = expectRefusal(
      doc,
      'pipe_wall_check',
      { ...nps4, allowableStress: undefined, millTolerance: undefined },
      'PSC_ALLOWABLE_MISSING',
      'allowableStress',
    );
    expect(result.error?.paths).toEqual(['allowableStress', 'millTolerance']);
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, coefficientY: undefined }, 'PSC_ALLOWABLE_MISSING', 'coefficientY');
  });

  it.each([
    ['jointFactorE', 1.2],
    ['jointFactorE', 0],
    ['weldStrengthW', 1.01],
    ['weldStrengthW', -0.5],
    ['coefficientY', 0.8],
    ['coefficientY', -0.1],
    ['millTolerance', 0.5],
    ['millTolerance', -0.01],
    ['millTolerance', 12.5],
  ])('refuses %s = %s with PSC_WALL_INPUT_RANGE', (name, value) => {
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, [name]: value }, 'PSC_WALL_INPUT_RANGE', name);
  });

  it('refuses a non-finite number and a zero or negative corrosion allowance sign problem', () => {
    expectRefusal(
      doc,
      'pipe_wall_check',
      { ...nps4, corrosionAllowance: { value: -1, unit: 'mm' } },
      'PSC_WALL_INPUT_RANGE',
      'corrosionAllowance',
    );
    expect(execute(doc, 'pipe_wall_check', { ...nps4, coefficientY: Number.NaN }).rejected).toBe(true);
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, pressure: { value: 0, unit: 'psi' } }, 'PSC_WALL_INPUT_RANGE', 'pressure');
    expectRefusal(
      doc,
      'pipe_wall_check',
      { ...nps4, allowableStress: { value: 0, unit: 'psi' } },
      'PSC_WALL_INPUT_RANGE',
      'allowableStress',
    );
  });

  it('refuses P/(S E) above 0.385 as a thick-wall pipe, in any pressure unit', () => {
    const thick = oracle.derived.find((entry) => entry['id'] === 'thick-wall-ratio') as Record<string, number>;
    const base = {
      odMm: 100,
      allowableStress: { value: thick['allowableStressMPa'], unit: 'MPa' },
      jointFactorE: 1,
      weldStrengthW: 1,
      coefficientY: 0.4,
      corrosionAllowance: { value: 0, unit: 'mm' },
      millTolerance: 0,
    };
    const mpa = expectRefusal(
      doc,
      'pipe_wall_check',
      { ...base, pressure: { value: thick['refusedPressureMPa'], unit: 'MPa' } },
      'PSC_WALL_THICK_PIPE',
      'pressure',
    );
    expect(mpa.summary).toContain('0.385');
    const psi = (thick['refusedPressureMPa'] as number) / 0.00689475729;
    expectRefusal(
      doc,
      'pipe_wall_check',
      {
        ...base,
        allowableStress: { value: (thick['allowableStressMPa'] as number) / 0.00689475729, unit: 'psi' },
        pressure: { value: psi, unit: 'psi' },
      },
      'PSC_WALL_THICK_PIPE',
    );
    expect(execute(doc, 'pipe_wall_check', { ...base, pressure: { value: 6, unit: 'MPa' } }).rejected).toBeUndefined();
  });

  it('refuses t >= D/6 through the D/6 gate even when P/(S E) is below 0.385', () => {
    const entry = oracle.derived.find((item) => item['id'] === 't-over-d6-binds-first') as Record<string, number>;
    const params = {
      odMm: entry['odMm'],
      pressure: { value: entry['pressureMPa'], unit: 'MPa' },
      allowableStress: { value: entry['allowableStressMPa'], unit: 'MPa' },
      jointFactorE: entry['jointFactorE'],
      weldStrengthW: entry['weldStrengthW'],
      coefficientY: entry['coefficientY'],
      corrosionAllowance: { value: 0, unit: 'mm' },
      millTolerance: 0,
    };
    expect((entry['ratio'] as number) < 0.385).toBe(true);
    const result = expectRefusal(doc, 'pipe_wall_check', params, 'PSC_WALL_THICK_PIPE', 'pressure');
    expect(result.summary).toContain('D/6');
    const thin = execute(doc, 'pipe_wall_check', { ...params, pressure: { value: 30, unit: 'MPa' } });
    expect(thin.rejected).toBeUndefined();
    near((thin.data as Record<string, number>)['pressureThicknessMm'], (30 * 100) / (2 * 138), 1e-9);
  });
});

describe('pipe_wall_check, size and schedule selection', () => {
  it('checks an explicit wall at an arbitrary OD, and refuses one that is too thin', () => {
    const params = { ...nps4, nps: undefined, odMm: 114.3 };
    const fine = data<Wall>(doc, 'pipe_wall_check', { ...params, wallMm: 9 });
    expect(fine['selectedSchedule']).toBeUndefined();
    expect(fine['selectedWallMm']).toBe(9);
    expectRefusal(doc, 'pipe_wall_check', { ...params, wallMm: 7 }, 'PSC_WALL_INSUFFICIENT', 'wallMm');
    const unselected = data<Wall>(doc, 'pipe_wall_check', params);
    expect(unselected['selectedWallMm']).toBeUndefined();
    near(unselected['requiredNominalMm'], reference.requiredNominalMm, 1e-3);
  });

  it('searches the stainless B36.19M schedules when asked and keeps the standards apart', () => {
    const wall = check({
      standard: 'ASME B36.19M',
      allowableStress: { value: 16700, unit: 'psi' },
      pressure: { value: 150, unit: 'psi' },
      corrosionAllowance: { value: 0, unit: 'mm' },
      millTolerance: 0,
      coefficientY: 0.4,
    });
    expect(String(wall['selectedSchedule'])).toMatch(/S$/);
  });

  it('reports a row that is not grade A as unverified (the STD wall of NPS 4 has one source)', () => {
    const wall = check({ schedule: 'STD', pressure: { value: 700, unit: 'psi' } });
    expect(wall['verified']).toBe(false);
    expect((wall['warnings'] as Array<{ code: string }>)[0]?.code).toBe('PSC_DATA_UNVERIFIED');
  });

  it('prefers a numbered schedule when walls tie (an imported catalogue with XS = 80)', () => {
    const imported = execute(doc, 'import_piping_catalog', {
      catalog: {
        format: 'llull-piping-catalog',
        schemaVersion: 1,
        id: 'tie',
        licence: 'open-data',
        families: [
          {
            id: 'tie-b36.10m',
            type: 'pipe',
            standard: 'ASME B36.10M',
            sizes: [
              { nps: 4, schedule: 'XS', outsideDiameter: 114.3, wall: 8.56, provenance: { citation: 'test' } },
              { nps: 4, schedule: '80', outsideDiameter: 114.3, wall: 8.56, provenance: { citation: 'test' } },
              { nps: 4, schedule: '40', outsideDiameter: 114.3, wall: 6.02, provenance: { citation: 'test' } },
            ],
          },
        ],
      },
    });
    expect(imported.rejected, imported.summary).toBeUndefined();
    const wall = data<Wall>(imported.document, 'pipe_wall_check', { ...nps4, catalogId: 'tie' });
    expect(wall['selectedSchedule']).toBe('80');
    expect(wall.candidates.map((candidate) => candidate.schedule)).toEqual(['80', 'XS']);
    expect(wall['verified']).toBe(false);
  });

  it('refuses unknown sizes, schedules, catalogues, conflicting size inputs and standards the catalogue lacks', () => {
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, nps: 4.3 }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, dn: 100 }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, nps: undefined }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, schedule: '999' }, 'PSC_SCHEDULE_UNKNOWN', 'schedule');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, nps: undefined, odMm: 114.3, schedule: '40' }, 'PSC_SCHEDULE_UNKNOWN', 'schedule');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, catalogId: 'nope' }, 'PSC_CATALOG_UNKNOWN', 'catalogId');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, nps: 100 }, 'PSC_CATALOG_ROW_MISSING', 'nps');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, standard: 'EN 10220' }, 'PSC_CATALOG_ROW_MISSING', 'nps');
    expectRefusal(doc, 'pipe_wall_check', { ...nps4, schedule: '40', wallMm: 9 }, 'PSC_WALL_INPUT_RANGE', 'schedule');
  });

  it('refuses when no schedule of the standard is thick enough, saying so', () => {
    const result = expectRefusal(
      doc,
      'pipe_wall_check',
      { ...nps4, pressure: { value: 5000, unit: 'psi' }, allowableStress: { value: 20000, unit: 'psi' }, coefficientY: 0.4 },
      'PSC_WALL_INSUFFICIENT',
    );
    expect(result.summary).toContain('no ASME B36.10M schedule');
    expect(result.error?.detail?.['lightestSchedule']).toBeUndefined();
  });
});
