/**
 * VC-EQP-16: guardrails of the plant equipment queries (AGENT_FIRST AF-11 stable codes, AF-13 determinism, AF-31..33 provenance and review):
 * `reviewRequired`, `unverified` propagation, every code of the TECHNICAL_SPEC §7 error table reached with its paths, determinism of SC-EQP-01.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { remediationOf } from '@aec/plant/equipment/model';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { drumDocument, drumNozzles, mmDocument, separatorDocument, separatorNozzles, separatorParams } from './equipmentFixtures';

const SPEC = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/TECHNICAL_SPEC.md');
const specCodes = (): string[] => {
  const section = readFileSync(SPEC, 'utf8').split('### Stable error codes (AF-11)')[1]?.split('## 8.')[0] ?? '';
  return [...section.matchAll(/^\| `(EQP_[A-Z0-9_]+)` \|/gm)].map((match) => match[1] as string);
};

/** Codes of the M4 templates (exchanger, tank, pump) that cannot be reached before those commands exist. */
const PENDING_M4 = ['EQP_TEMA_INVALID', 'EQP_TEMA_UNSUPPORTED', 'EQP_PUMP_SIZE_UNKNOWN'];
const M4_COMMANDS = ['add_heat_exchanger', 'add_storage_tank', 'add_pump'];

const fireWaterTank = {
  diameter: 20000,
  shellHeight: 12000,
  courses: [2000, 2000, 2000, 2000, 2000, 2000],
  designLiquidLevel: 12000,
  specificGravity: 1,
  material: 'A36M',
  corrosionAllowance: 1.5,
};

describe('VC-EQP-16: the error table of the specification', () => {
  const codes = specCodes();

  it('lists every code with a remediation, and the codes of M4 only wait for their commands (they cannot be reached before)', () => {
    expect(codes.length).toBeGreaterThanOrEqual(30);
    for (const code of codes.filter((candidate) => !PENDING_M4.includes(candidate)))
      expect(remediationOf(code), code).not.toBe('see the command description');
    for (const name of M4_COMMANDS)
      expect(getCommand(name), `${name} exists: reach ${PENDING_M4.join(', ')} in a test and shrink PENDING_M4`).toBeUndefined();
  });

  it('M3 refusals carry the stable code, the param path, a remediation, and leave the document unchanged', () => {
    const separator = separatorDocument(false);
    const { design, ...bare } = separatorParams;
    const bareVessel = apply(mmDocument(), 'add_vessel', { ...bare, design: { pressure: design.pressure } });
    const conical = { type: 'conical', halfAngleDeg: 45 };
    const conicalVessel = apply(mmDocument(), 'add_vessel', { ...separatorParams, heads: { top: conical, bottom: conical } });
    const block = apply(mmDocument(), 'add_equipment', { name: 'Skid', mark: 'S-1', location: [0, 0], size: [1000, 1000, 1000] });
    const refusals: Array<[string, CadDocument, string, object, string]> = [
      ['EQP_NOT_FOUND', separator, 'vessel_thickness', { equipment: 'X-1' }, 'equipment'],
      ['EQP_NOT_FOUND', separator, 'equipment_weights', { equipment: 'X-1' }, 'equipment'],
      ['EQP_NOT_PARAMETRIC', block, 'vessel_thickness', { equipment: 'S-1' }, 'equipment'],
      ['EQP_NOT_PARAMETRIC', block, 'equipment_weights', { equipment: 'S-1' }, 'equipment'],
      ['EQP_ALLOWABLE_MISSING', bareVessel, 'vessel_thickness', { equipment: 'V-101' }, 'design.allowableStress'],
      ['EQP_DESIGN_DATA_MISSING', apply(mmDocument(), 'add_vessel', bare), 'vessel_thickness', { equipment: 'V-101' }, 'design.pressure'],
      ['EQP_FORMULA_OUT_OF_RANGE', separator, 'vessel_thickness', { equipment: 'V-101', pressure: { value: 60, unit: 'MPa' } }, 'pressure'],
      ['EQP_HEAD_NOT_COVERED', conicalVessel, 'vessel_thickness', { equipment: 'V-101' }, 'heads.first'],
      ['EQP_API650_ONE_FOOT_LIMIT', mmDocument(), 'tank_shell_thickness', { ...fireWaterTank, diameter: 61000 }, 'diameter'],
      ['EQP_MATERIAL_NOT_IN_TABLE', mmDocument(), 'tank_shell_thickness', { ...fireWaterTank, material: 'S355' }, 'material'],
      ['EQP_COURSES_MISMATCH', mmDocument(), 'tank_shell_thickness', { ...fireWaterTank, courses: [2000] }, 'courses'],
    ];
    for (const [code, doc, command, params, at] of refusals) {
      const result = expectRefusal(doc, command, params, code, at);
      expect(result.summary, `${command} ${code}`).toContain(code);
    }
  });

  it('M3 findings of check_equipment: fails and warnings, each with ids, paths, message and remediation', () => {
    const thin = apply(drumDocument(), 'update_equipment_parameters', {
      equipment: 'D-201',
      set: { shellThickness: 12, headThickness: 5 },
    });
    const [inlet] = separatorNozzles as unknown as [Record<string, unknown>];
    const [, overSaddle] = drumNozzles as unknown as [unknown, Record<string, unknown>];
    let busy = apply(thin, 'add_nozzle', {
      equipment: 'D-201',
      ...overSaddle,
      mark: 'S1',
      location: { on: 'shell', station: 1200, orientationDeg: 180 },
    });
    busy = apply(busy, 'add_nozzle', {
      equipment: 'D-201',
      ...inlet,
      mark: 'K1',
      dn: 50,
      location: { on: 'head', head: 'left', radialOffset: 950 },
    });
    busy = apply(busy, 'add_nozzle', {
      equipment: 'D-201',
      ...inlet,
      mark: 'K2',
      dn: 50,
      location: { on: 'head', head: 'left', radialOffset: 950 },
    });
    busy = apply(busy, 'update_equipment_parameters', {
      equipment: 'D-201',
      set: { design: { allowableStress: { value: 137.9, unit: 'MPa' } } },
    });
    const found = new Map<string, string>();
    for (const issue of data<{
      issues: Array<{ code: string; severity: string; ids: string[]; paths: string[]; message: string; remediation: string }>;
    }>(busy, 'check_equipment', {}).issues) {
      expect(issue.ids.length + issue.paths.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(10);
      expect(issue.remediation.length).toBeGreaterThan(10);
      found.set(issue.code, issue.severity);
    }
    expect([...found.entries()].sort()).toEqual(
      [
        ['EQP_SHELL_UNDER_THICKNESS', 'fail'],
        ['EQP_HEAD_UNDER_THICKNESS', 'fail'],
        ['EQP_MAWP_BELOW_DESIGN', 'fail'],
        ['EQP_NOZZLE_IN_SUPPORT', 'warning'],
        ['EQP_NOZZLE_IN_KNUCKLE', 'warning'],
        ['EQP_NOZZLE_OVERLAP', 'warning'],
        ['EQP_VALUE_UNSOURCED', 'warning'],
        ['EQP_TABLE_UNVERIFIED', 'warning'],
      ].sort(),
    );
  });
});

describe('VC-EQP-16: reviewRequired, unverified, determinism', () => {
  it('every result that reports a code thickness or MAWP says reviewRequired: true and names the standard', () => {
    const vessel = data<{ reviewRequired: boolean; reviewReason: string }>(separatorDocument(false), 'vessel_thickness', {
      equipment: 'V-101',
    });
    expect(vessel).toMatchObject({ reviewRequired: true, reviewReason: expect.stringContaining('ASME VIII-1') });
    const tank = data<{ reviewRequired: boolean; reviewReason: string }>(mmDocument(), 'tank_shell_thickness', fireWaterTank);
    expect(tank).toMatchObject({ reviewRequired: true, reviewReason: expect.stringContaining('API 650') });
    const check = data<{ reviewRequired: boolean; reviewReason: string }>(separatorDocument(), 'check_equipment', {});
    expect(check).toMatchObject({ reviewRequired: true, reviewReason: expect.stringContaining('ASME VIII-1') });
  });

  it('a grade B/C table row or an unsourced value sets unverified in the query and a warning code in the check', () => {
    const tank = data<{ unverified: boolean; warnings: Array<{ code: string }> }>(mmDocument(), 'tank_shell_thickness', fireWaterTank);
    expect(tank.unverified).toBe(true);
    expect(tank.warnings.map((warning) => warning.code)).toEqual(['EQP_TABLE_UNVERIFIED']);
    const unsourced = apply(separatorDocument(false), 'update_equipment_parameters', {
      equipment: 'V-101',
      set: { design: { allowableStress: { value: 137.9, unit: 'MPa' } } },
    });
    const thickness = data<{ unverified: boolean; warnings: Array<{ code: string }> }>(unsourced, 'vessel_thickness', {
      equipment: 'V-101',
    });
    expect(thickness).toMatchObject({ unverified: true, warnings: [{ code: 'EQP_VALUE_UNSOURCED' }] });
    expect(data<{ unverified: boolean }>(separatorDocument(false), 'vessel_thickness', { equipment: 'V-101' }).unverified).toBe(false);
    const weights = data<{ unverified: boolean }>(separatorDocument(), 'equipment_weights', {
      equipment: 'V-101',
      include: ['body', 'nozzles'],
    });
    expect(weights.unverified).toBe(true);
  });

  it('SC-EQP-01 twice gives byte-identical output of every M3 query (ids, numbers, order)', () => {
    const run = (): string => {
      const doc = separatorDocument();
      return JSON.stringify(
        [
          ['vessel_thickness', { equipment: 'V-101' }],
          ['equipment_weights', { equipment: 'V-101', include: ['body', 'nozzles'] }],
          ['check_equipment', { equipment: ['V-101'] }],
          ['tank_shell_thickness', fireWaterTank],
        ].map(([name, params]) => {
          const { summary, data: answer, affected } = execute(doc, name as string, params);
          return { summary, answer, affected };
        }),
      );
    };
    expect(run()).toBe(run());
  });
});
