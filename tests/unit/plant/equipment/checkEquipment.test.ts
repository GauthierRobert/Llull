/** `check_equipment`: status precedence, fail / warning findings with codes and paths, ordering, scope (plan steps 10 and 12 of SC-EQP-01 / 02). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import {
  drumDocument,
  drumNozzles,
  drumParams,
  mmDocument,
  separatorDocument,
  separatorNozzles,
  separatorParams,
} from './equipmentFixtures';

interface Issue {
  code: string;
  severity: 'fail' | 'warning';
  ids: string[];
  paths: string[];
  message: string;
  remediation: string;
}
interface Check {
  status: string;
  issues: Issue[];
  checked: Array<{ tag: string; id: string; status: string }>;
  reviewRequired: boolean;
  reviewReason?: string;
}

const check = (doc: CadDocument, equipment?: string[]): Check =>
  data<Check>(doc, 'check_equipment', equipment === undefined ? {} : { equipment });
const codes = (result: Check): string[] => result.issues.map((issue) => issue.code);
const withNozzle = (doc: CadDocument, equipment: string, nozzle: object): CadDocument => apply(doc, 'add_nozzle', { equipment, ...nozzle });

describe('check_equipment: status precedence (fail > warn > pass_with_review > pass)', () => {
  it('SC-EQP-01 (step 10): no fail, warnings for the nozzle flanges, status warn, review required', () => {
    const result = check(separatorDocument(), ['V-101']);
    expect(result.status).toBe('warn');
    expect(result.issues.filter((issue) => issue.severity === 'fail')).toHaveLength(0);
    expect(codes(result)).toContain('EQP_FLANGE_PLACEHOLDER');
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReason).toContain('ASME VIII-1');
    expect(result.checked).toEqual([{ tag: 'V-101', id: expect.any(String), status: 'warn' }]);
    for (const issue of result.issues) {
      expect(issue.ids).toHaveLength(1);
      expect(issue.paths.length).toBeGreaterThan(0);
      expect(issue.remediation.length).toBeGreaterThan(10);
    }
  });

  it('a clean vessel (no nozzles) passes with review: the code check ran, a human still signs', () => {
    const result = check(separatorDocument(false));
    expect(result).toMatchObject({ status: 'pass_with_review', issues: [], reviewRequired: true });
  });

  it('nothing to check passes without review: no equipment, or only a legacy block', () => {
    expect(check(mmDocument())).toMatchObject({ status: 'pass', issues: [], checked: [], reviewRequired: false });
    const block = apply(mmDocument(), 'add_equipment', { name: 'Skid', mark: 'S-1', location: [0, 0], size: [1000, 1000, 1000] });
    expect(check(block)).toMatchObject({ status: 'pass', checked: [], reviewRequired: false });
  });

  it('SC-EQP-02 (step 12): a 12 mm shell fails with EQP_SHELL_UNDER_THICKNESS and EQP_MAWP_BELOW_DESIGN, ahead of the warnings', () => {
    const drum = drumDocument();
    expect(check(drum, ['D-201']).status).toBe('warn');
    const thin = apply(drum, 'update_equipment_parameters', { equipment: 'D-201', set: { shellThickness: 12 } });
    const result = check(thin, ['D-201']);
    expect(result.status).toBe('fail');
    const fails = result.issues.filter((issue) => issue.severity === 'fail');
    expect(fails.map((issue) => issue.code)).toEqual(['EQP_MAWP_BELOW_DESIGN', 'EQP_SHELL_UNDER_THICKNESS']);
    expect(fails.map((issue) => issue.paths)).toEqual([['shellThickness'], ['shellThickness']]);
    expect(result.issues.slice(0, 2)).toEqual(fails);
    expect(fails[0]?.message).toContain('MAWP 1.04615');
    expect(result.checked[0]?.status).toBe('fail');
  });

  it('a thin head fails EQP_HEAD_UNDER_THICKNESS with the headThickness path while the shell passes', () => {
    const doc = apply(separatorDocument(false), 'update_equipment_parameters', { equipment: 'V-101', set: { headThickness: 5 } });
    const result = check(doc);
    expect(result.status).toBe('fail');
    expect(result.issues.filter((issue) => issue.severity === 'fail').map((issue) => [issue.code, issue.paths[0]])).toContainEqual([
      'EQP_HEAD_UNDER_THICKNESS',
      'headThickness',
    ]);
    expect(codes(result)).not.toContain('EQP_SHELL_UNDER_THICKNESS');
  });
});

describe('check_equipment: warnings for what the formulas do not cover', () => {
  it('no design data -> EQP_DESIGN_DATA_MISSING (design.pressure); no allowable or no E -> EQP_ALLOWABLE_MISSING; nothing is passed silently', () => {
    const { design, ...bare } = separatorParams;
    const none = check(apply(mmDocument(), 'add_vessel', bare));
    expect(none.issues.map((issue) => [issue.code, issue.severity, issue.paths[0]])).toEqual([
      ['EQP_DESIGN_DATA_MISSING', 'warning', 'design.pressure'],
    ]);
    expect(none.status).toBe('warn');
    expect(none.reviewRequired).toBe(false);
    const noStress = check(apply(mmDocument(), 'add_vessel', { ...bare, design: { pressure: design.pressure } }));
    expect(noStress.issues.map((issue) => [issue.code, issue.paths[0]])).toEqual([['EQP_ALLOWABLE_MISSING', 'design.allowableStress']]);
    const noE = check(
      apply(mmDocument(), 'add_vessel', { ...bare, design: { pressure: design.pressure, allowableStress: design.allowableStress } }),
    );
    expect(noE.issues.map((issue) => [issue.code, issue.paths[0]])).toEqual([['EQP_ALLOWABLE_MISSING', 'design.jointEfficiency']]);
  });

  it('P above 0.385 S E -> the shell is a EQP_FORMULA_OUT_OF_RANGE warning (needs an engineer), not judged; the heads are still judged', () => {
    const high = apply(separatorDocument(false), 'update_equipment_parameters', {
      equipment: 'V-101',
      set: { design: { pressure: { value: 60, unit: 'MPa' } } },
    });
    const result = check(high);
    const warning = result.issues.filter((issue) => issue.severity === 'warning');
    expect(warning.map((issue) => [issue.code, issue.paths[0]])).toEqual([['EQP_FORMULA_OUT_OF_RANGE', 'design.pressure']]);
    expect(codes(result)).not.toContain('EQP_SHELL_UNDER_THICKNESS');
    expect(codes(result)).toContain('EQP_HEAD_UNDER_THICKNESS');
    expect(result.status).toBe('fail');
  });

  it('an uncovered head is a warning for that head only: the shell is still judged (and can still fail)', () => {
    const conical = { type: 'conical', halfAngleDeg: 45 };
    const doc = apply(mmDocument(), 'add_vessel', {
      ...separatorParams,
      heads: { top: conical, bottom: conical },
      shellThickness: 5,
      support: { type: 'none' },
    });
    const result = check(doc);
    expect(result.issues.filter((issue) => issue.code === 'EQP_HEAD_NOT_COVERED').map((issue) => issue.paths)).toEqual([
      ['heads.first'],
      ['heads.second'],
    ]);
    expect(codes(result)).toContain('EQP_SHELL_UNDER_THICKNESS');
    expect(result.status).toBe('fail');
    expect(result.reviewRequired).toBe(true);
  });

  it('an unsourced allowable stress -> EQP_VALUE_UNSOURCED, with and without a design pressure', () => {
    const unsourced = { value: 137.9, unit: 'MPa' };
    const doc = apply(separatorDocument(false), 'update_equipment_parameters', {
      equipment: 'V-101',
      set: { design: { allowableStress: unsourced } },
    });
    expect(check(doc).issues.map((issue) => [issue.code, issue.paths[0]])).toEqual([
      ['EQP_VALUE_UNSOURCED', 'design.allowableStress.source'],
    ]);
    const { design, ...bare } = separatorParams;
    const noPressure = apply(mmDocument(), 'add_vessel', {
      ...bare,
      design: { allowableStress: unsourced, jointEfficiency: design.jointEfficiency },
    });
    expect(codes(check(noPressure)).sort()).toEqual(['EQP_DESIGN_DATA_MISSING', 'EQP_VALUE_UNSOURCED']);
  });

  it('a head from a grade B proportion table is flagged EQP_TABLE_UNVERIFIED (and not covered by the formulas)', () => {
    const grade = { type: 'torispherical', standard: 'asme_80_10' };
    const doc = apply(mmDocument(), 'add_vessel', { ...separatorParams, heads: { top: grade, bottom: grade }, support: { type: 'none' } });
    const result = check(doc);
    expect(codes(result)).toContain('EQP_TABLE_UNVERIFIED');
    expect(result.issues.find((issue) => issue.code === 'EQP_TABLE_UNVERIFIED')?.paths).toEqual(['heads']);
    expect(codes(result)).toContain('EQP_HEAD_NOT_COVERED');
  });
});

describe('check_equipment: nozzle layout findings', () => {
  const [inlet, outlet] = separatorNozzles as unknown as [Record<string, unknown>, Record<string, unknown>];

  it('EQP_NOZZLE_IN_KNUCKLE: a head nozzle beyond 0.8 R, with the nozzle path', () => {
    const doc = withNozzle(separatorDocument(false), 'V-101', {
      ...outlet,
      mark: 'K1',
      location: { on: 'head', head: 'top', radialOffset: 700 },
    });
    const found = check(doc).issues.filter((issue) => issue.code === 'EQP_NOZZLE_IN_KNUCKLE');
    expect(found.map((issue) => issue.paths)).toEqual([['nozzles.K1.location.radialOffset']]);
    expect(found[0]?.severity).toBe('warning');
  });

  it('EQP_NOZZLE_OVERLAP is reported once per pair, naming both nozzles', () => {
    const doc = withNozzle(withNozzle(separatorDocument(false), 'V-101', inlet), 'V-101', {
      ...inlet,
      mark: 'N9',
      location: { on: 'shell', elevation: 3300, orientationDeg: 0 },
    });
    const found = check(doc).issues.filter((issue) => issue.code === 'EQP_NOZZLE_OVERLAP');
    expect(found).toHaveLength(1);
    expect(found[0]?.paths).toEqual(['nozzles.N1.location', 'nozzles.N9.location']);
  });

  it('EQP_NOZZLE_IN_SUPPORT: a bottom head nozzle that reaches the skirt wall, a shell nozzle over a saddle; clear nozzles do not warn', () => {
    const skirted = withNozzle(separatorDocument(false), 'V-101', {
      ...outlet,
      mark: 'B1',
      location: { on: 'head', head: 'bottom', radialOffset: 650 },
    });
    expect(
      check(skirted)
        .issues.filter((issue) => issue.code === 'EQP_NOZZLE_IN_SUPPORT')
        .map((issue) => issue.paths),
    ).toEqual([['nozzles.B1.location.radialOffset']]);
    expect(codes(check(withNozzle(separatorDocument(false), 'V-101', outlet)))).not.toContain('EQP_NOZZLE_IN_SUPPORT');
    const [, drainage] = drumNozzles as unknown as [unknown, Record<string, unknown>];
    const onSaddle = withNozzle(drumDocument(false), 'D-201', {
      ...drainage,
      mark: 'S1',
      location: { on: 'shell', station: 1200, orientationDeg: 180 },
    });
    expect(
      check(onSaddle)
        .issues.filter((issue) => issue.code === 'EQP_NOZZLE_IN_SUPPORT')
        .map((issue) => issue.paths),
    ).toEqual([['nozzles.S1.location']]);
    const clear = withNozzle(drumDocument(false), 'D-201', {
      ...drainage,
      mark: 'S2',
      location: { on: 'shell', station: 3000, orientationDeg: 180 },
    });
    expect(codes(check(clear))).not.toContain('EQP_NOZZLE_IN_SUPPORT');
    const topSide = withNozzle(drumDocument(false), 'D-201', {
      ...drainage,
      mark: 'S3',
      location: { on: 'shell', station: 1200, orientationDeg: 0 },
    });
    expect(codes(check(topSide))).not.toContain('EQP_NOZZLE_IN_SUPPORT');
  });
});

describe('check_equipment: scope, order, purity', () => {
  it('unknown references are fail findings EQP_NOT_FOUND with the index path; duplicates are checked once; the scope list restricts the check', () => {
    const both = apply(separatorDocument(false), 'add_vessel', { ...drumParams, location: [20000, 0] });
    const result = check(both, ['V-101', 'V-101', 'V-404']);
    expect(result.checked.map((entry) => entry.tag)).toEqual(['V-101']);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'EQP_NOT_FOUND', severity: 'fail', ids: [], paths: ['equipment.2'] })]);
    expect(result.status).toBe('fail');
    expect(check(both).checked.map((entry) => entry.tag)).toEqual(['V-101', 'D-201']);
  });

  it('issues are sorted by severity, then code, and the whole answer is deterministic', () => {
    const doc = apply(drumDocument(), 'update_equipment_parameters', { equipment: 'D-201', set: { shellThickness: 12 } });
    const first = check(doc);
    const order = first.issues.map((issue) => `${issue.severity === 'fail' ? 0 : 1}:${issue.code}`);
    expect(order).toEqual([...order].sort());
    expect(JSON.stringify(check(doc))).toBe(JSON.stringify(first));
  });

  it('is read-only: the same document object comes back, nothing affected', () => {
    const doc = separatorDocument();
    const result = execute(doc, 'check_equipment', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('the shell numbers are those of vessel_thickness (one source of truth)', () => {
    const doc = apply(drumDocument(false), 'update_equipment_parameters', { equipment: 'D-201', set: { shellThickness: 12 } });
    const thickness = data<{ components: { shell: { mawpMPa: number } } }>(doc, 'vessel_thickness', { equipment: 'D-201' });
    const message = check(doc).issues.find((issue) => issue.code === 'EQP_MAWP_BELOW_DESIGN')?.message ?? '';
    expect(message).toContain(thickness.components.shell.mawpMPa.toPrecision(6));
  });
});
