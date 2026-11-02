/**
 * VC-EQP-16: guardrails of the plant equipment queries (AGENT_FIRST AF-11 stable codes, AF-13 determinism, AF-31..33 provenance and review):
 * `reviewRequired`, `unverified` propagation, every code of the TECHNICAL_SPEC §7 error table reached with its paths, determinism of SC-EQP-01.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { remediationOf } from '@aec/plant/equipment/model';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import {
  bemDocument,
  bemParams,
  drumDocument,
  drumNozzles,
  mmDocument,
  pumpDocument,
  separatorDocument,
  separatorNozzles,
  separatorParams,
  tankDocument,
  tankParams,
} from './equipmentFixtures';

const SPEC = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/TECHNICAL_SPEC.md');
const specCodes = (): string[] => {
  const section = readFileSync(SPEC, 'utf8').split('### Stable error codes (AF-11)')[1]?.split('## 8.')[0] ?? '';
  return [...section.matchAll(/^\| `(EQP_[A-Z0-9_]+)` \|/gm)].map((match) => match[1] as string);
};

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

  it('lists every code with a remediation', () => {
    expect(codes.length).toBeGreaterThanOrEqual(30);
    for (const code of codes) expect(remediationOf(code), code).not.toBe('see the command description');
  });

  it('M4 refusals carry the stable code, the param path, a remediation, and leave the document unchanged', () => {
    const { rearChannel: _rear, ...bem } = bemParams;
    const unsized = apply(mmDocument(), 'add_pump', { tag: 'P-1', location: [0, 0], standard: 'iso_2858', size: '65-40-250' });
    const refusals: Array<[string, CadDocument, string, object, string]> = [
      ['EQP_TEMA_INVALID', mmDocument(), 'add_heat_exchanger', { ...bemParams, temaType: 'BXZ' }, 'temaType.2'],
      ['EQP_TEMA_INVALID', mmDocument(), 'add_heat_exchanger', { ...bemParams, temaType: 'BE' }, 'temaType'],
      ['EQP_TEMA_UNSUPPORTED', mmDocument(), 'add_heat_exchanger', { ...bemParams, temaType: 'AKT' }, 'temaType.1'],
      ['EQP_PARAM_INVALID', mmDocument(), 'add_heat_exchanger', { ...bem, temaType: 'AES', rearChannel: { length: 300 } }, 'rearChannel'],
      [
        'EQP_SUPPORT_INVALID',
        mmDocument(),
        'add_heat_exchanger',
        { ...bemParams, support: { type: 'skirt', height: 500 } },
        'support.type',
      ],
      ['EQP_TAG_DUPLICATE', bemDocument(false), 'add_heat_exchanger', bemParams, 'tag'],
      ['EQP_COURSES_MISMATCH', mmDocument(), 'add_storage_tank', { ...tankParams, courses: [2000] }, 'courses'],
      ['EQP_API650_ONE_FOOT_LIMIT', mmDocument(), 'add_storage_tank', { ...tankParams, diameter: 61000 }, 'diameter'],
      [
        'EQP_MATERIAL_NOT_IN_TABLE',
        mmDocument(),
        'add_storage_tank',
        { ...tankParams, design: { ...tankParams.design, material: 'S355' } },
        'design.material',
      ],
      ['EQP_API650_ONE_FOOT_LIMIT', tankDocument(), 'tank_shell_thickness', { equipment: 'T-401', overrideDiameterM: 65 }, 'diameter'],
      [
        'EQP_PUMP_SIZE_UNKNOWN',
        mmDocument(),
        'add_pump',
        { tag: 'P-1', location: [0, 0], standard: 'iso_2858', size: '125-100-315' },
        'size',
      ],
      ['EQP_PUMP_SIZE_UNKNOWN', mmDocument(), 'add_pump', { tag: 'P-1', location: [0, 0], standard: 'asme_b73_1' }, 'size'],
      ['EQP_NOT_PARAMETRIC', pumpDocument(), 'update_equipment_parameters', { equipment: 'P-101', set: { name: 'x' } }, 'equipment'],
      ['EQP_DESIGN_DATA_MISSING', unsized, 'equipment_weights', { equipment: 'P-1' }, 'weightKg'],
    ];
    for (const [code, doc, command, params, at] of refusals) {
      const result = expectRefusal(doc, command, params, code, at);
      expect(result.summary, `${command} ${code}`).toContain(code);
    }
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

describe('VC-EQP-16: M4 equipment findings and provenance', () => {
  it('every kind of equipment says what its check does NOT cover; every kind needs review (pumps: hydraulics, casing rating, nozzle loads)', () => {
    const doc = apply(apply(apply(mmDocument(), 'add_heat_exchanger', bemParams), 'add_storage_tank', tankParams), 'add_pump', {
      tag: 'P-101',
      location: [0, 0],
      standard: 'iso_2858',
      size: '65-40-250',
    });
    const report = data<{
      reviewRequired: boolean;
      reviewReason: string;
      checked: Array<{ tag: string; status: string; notChecked: string[] }>;
    }>(doc, 'check_equipment', {});
    expect(report.checked.map((row) => row.tag)).toEqual(['E-301', 'T-401', 'P-101']);
    for (const row of report.checked) {
      expect(row.notChecked.length, row.tag).toBeGreaterThan(2);
      expect(row.status, row.tag).not.toBe('pass');
    }
    expect(report.reviewRequired).toBe(true);
    expect(report.reviewReason).toContain('exchanger');
    expect(report.reviewReason).toContain('API 650');
    expect(data<{ reviewRequired: boolean }>(doc, 'check_equipment', { equipment: ['P-101'] }).reviewRequired).toBe(true);
  });

  it('an explicitly named element that cannot be judged is never a pass: unknown tags fail, legacy blocks warn', () => {
    const block = apply(mmDocument(), 'add_equipment', { name: 'Skid', mark: 'S-1', location: [0, 0], size: [1000, 1000, 1000] });
    const report = data<{ status: string; issues: Array<{ code: string; severity: string }> }>(block, 'check_equipment', {
      equipment: ['S-1', 'X-9'],
    });
    expect(report.issues.map((issue) => [issue.code, issue.severity])).toEqual([
      ['EQP_NOT_FOUND', 'fail'],
      ['EQP_NOT_PARAMETRIC', 'warning'],
    ]);
    expect(report.status).toBe('fail');
  });

  it('unverified propagates: BWG tube walls, grade B pump rows, derived tank thicknesses', () => {
    const { wallThickness: _wall, ...tubes } = bemParams.tubes;
    const exchanger = apply(mmDocument(), 'add_heat_exchanger', { ...bemParams, tubes: { ...tubes, bwg: 16 } });
    expect(data<{ unverified: boolean }>(exchanger, 'vessel_volume', { equipment: 'E-301' }).unverified).toBe(true);
    const pump = data<{ unverified: boolean }>(mmDocument(), 'add_pump', {
      tag: 'P-1',
      location: [0, 0],
      standard: 'asme_b73_1',
      size: 'AA',
    });
    expect(pump.unverified).toBe(true);
    expect(data<{ unverified: boolean }>(tankDocument(), 'tank_shell_thickness', { equipment: 'T-401' }).unverified).toBe(true);
  });

  it('the M4 queries are deterministic: the same document twice gives byte-identical answers', () => {
    const run = (): string => {
      const doc = apply(apply(bemDocument(), 'add_storage_tank', tankParams), 'add_pump', {
        tag: 'P-101',
        location: [0, 0],
        standard: 'iso_2858',
        size: '65-40-250',
        weightKg: 300,
      });
      return JSON.stringify(
        [
          ['check_equipment', {}],
          ['equipment_weights', { equipment: 'E-301', include: ['body', 'nozzles'] }],
          ['equipment_weights', { equipment: 'T-401' }],
          ['equipment_weights', { equipment: 'P-101' }],
          ['vessel_volume', { equipment: 'E-301' }],
          ['vessel_volume', { equipment: 'T-401', levels: [1000, 6000] }],
          ['tank_shell_thickness', { equipment: 'T-401' }],
          ['equipment_ports', {}],
        ].map(([name, params]) => {
          const { summary, data: answer, affected } = execute(doc, name as string, params);
          return { summary, answer, affected };
        }),
      );
    };
    expect(run()).toBe(run());
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
