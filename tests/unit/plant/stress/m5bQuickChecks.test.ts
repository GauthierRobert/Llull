/** Plant 07 PST M5b quick checks: `spring_variability` (VC-PST-14) and `nozzle_load_check` (VC-PST-15); references read from the validation pack. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';

const DATA = path.resolve(__dirname, '../../../../docs/plant/07-pipe-stress-flexibility/validation/data');
const reference = JSON.parse(readFileSync(path.join(DATA, 'nozzle_limits_reference.json'), 'utf8')) as {
  api610_table5_nps6_usc: { source: string; forcesLbf: Record<string, Record<string, number>>; momentsFtLbf: Record<string, number> };
  nema_sm23_example: {
    expected: { De_in: number; ratio: number };
    expected2: { De_in: number; ratio: number; lhs: number; limit: number };
  };
};

const doc = createEmptyDocument();
const run = (name: string, params: Record<string, unknown>): CommandResult => execute(doc, name, params);
const data = (result: CommandResult): Record<string, unknown> => result.data as Record<string, unknown>;

describe('spring_variability (VC-PST-14)', () => {
  it('10 kN hot, 100 N/mm, 20 mm up: cold 12 kN, variability 0.20, within the named 0.25 default', () => {
    const result = run('spring_variability', { hotLoadN: 10000, rateNPerMm: 100, travelUpMm: 20 });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(data(result)['coldLoadN']).toBeCloseTo(12000, 6);
    expect(data(result)['variability']).toBeCloseTo(0.2, 9);
    expect(data(result)['ok']).toBe(true);
    expect(data(result)['defaulted']).toEqual(['maxVariability=0.25']);
    expect(data(result)['grade']).toBe('B');
    expect(data(result)['reviewRequired']).toBe(true);
  });

  it('30 mm up gives variability 0.30 and the coded refusal with the numbers in the detail', () => {
    const result = run('spring_variability', { hotLoadN: 10000, rateNPerMm: 100, travelUpMm: 30 });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('PST_SPRING_VARIABILITY');
    expect(result.error?.detail?.['variability']).toBeCloseTo(0.3, 9);
    expect(result.error?.detail?.['coldLoadN']).toBeCloseTo(13000, 6);
    expect(result.document).toBe(doc);
  });

  it('a travel down unloads the cold load: negative d gives P_cold = P_hot - k |d|; a stated limit of 0.35 admits 0.30', () => {
    const down = run('spring_variability', { hotLoadN: 10000, rateNPerMm: 100, travelUpMm: -10 });
    expect(data(down)['coldLoadN']).toBeCloseTo(9000, 6);
    expect(data(down)['variability']).toBeCloseTo(0.1, 9);
    const stated = run('spring_variability', { hotLoadN: 10000, rateNPerMm: 100, travelUpMm: 30, maxVariability: 0.35 });
    expect(data(stated)['ok']).toBe(true);
    expect(data(stated)['defaulted']).toEqual([]);
  });

  it('refuses a spring whose cold load would not be positive and bad inputs', () => {
    const negative = run('spring_variability', { hotLoadN: 1000, rateNPerMm: 100, travelUpMm: -20, maxVariability: 1 });
    expect(negative.error?.code).toBe('PST_PARAM_INVALID');
    expect(run('spring_variability', { hotLoadN: 0, rateNPerMm: 100, travelUpMm: 1 }).rejected).toBe(true);
    expect(run('spring_variability', { hotLoadN: 100, rateNPerMm: 100 }).rejected).toBe(true);
  });
});

describe('nozzle_load_check (VC-PST-15)', () => {
  it('NEMA SM 23 NPS 6, F 500 lbf, M 1200 ft.lbf: De 6, 3F + M = 2700 of 3000, ratio 0.9', () => {
    const result = run('nozzle_load_check', { standard: 'nema_sm23', nominalIn: 6, forceLbf: [500, 0, 0], momentFtLbf: [0, 1200, 0] });
    expect(result.rejected).toBeUndefined();
    expect(data(result)['De']).toBeCloseTo(6, 12);
    expect(data(result)['lhs']).toBeCloseTo(2700, 9);
    expect(data(result)['limit']).toBeCloseTo(3000, 9);
    expect(data(result)['ratio']).toBeCloseTo(reference.nema_sm23_example.expected.ratio, 9);
    expect(data(result)['grade']).toBe('B');
  });

  it('NEMA SM 23 NPS 10, F 600, M 2000: De (16 + 10) / 3, ratio 3800 / 4333.33', () => {
    const result = run('nozzle_load_check', { standard: 'nema_sm23', nominalIn: 10, forceLbf: [0, 600, 0], momentFtLbf: [2000, 0, 0] });
    const e = reference.nema_sm23_example.expected2;
    expect(Math.abs((data(result)['De'] as number) - e.De_in)).toBeLessThan(e.De_in * 1e-4);
    expect(data(result)['lhs']).toBeCloseTo(e.lhs, 9);
    expect(Math.abs((data(result)['ratio'] as number) - e.ratio)).toBeLessThan(e.ratio * 1e-6);
  });

  it('uses the resultants of the components and converts SI loads (1 lbf = 4.4482216 N, 1 ft.lbf = 1.3558179 N.m)', () => {
    const usc = run('nozzle_load_check', { standard: 'nema_sm23', nominalIn: 6, forceLbf: [300, 400, 0], momentFtLbf: [600, 800, 0] });
    expect(data(usc)['lhs']).toBeCloseTo(3 * 500 + 1000, 9);
    const si = run('nozzle_load_check', {
      standard: 'nema_sm23',
      nominalIn: 6,
      forceN: [300 * 4.4482216152605, 400 * 4.4482216152605, 0],
      momentNm: [600 * 1.3558179483314, 800 * 1.3558179483314, 0],
    });
    expect(data(si)['ratio'] as number).toBeCloseTo(data(usc)['ratio'] as number, 9);
  });

  it('API 617 allows 1.85 times the NEMA load: the NPS 10 case gives 0.877 / 1.85', () => {
    const result = run('nozzle_load_check', { standard: 'api617', nominalIn: 10, forceLbf: [0, 600, 0], momentFtLbf: [2000, 0, 0] });
    expect(data(result)['ratio'] as number).toBeCloseTo(0.876923 / 1.85, 6);
    expect(data(result)['rule']).toBe('NOZZLE-API617');
  });

  it('a NEMA load over the limit is refused with PST_NOZZLE_OVERLOAD and the check in the detail', () => {
    const result = run('nozzle_load_check', { standard: 'nema_sm23', nominalIn: 6, forceLbf: [1000, 0, 0], momentFtLbf: [0, 1200, 0] });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('PST_NOZZLE_OVERLOAD');
    expect(result.error?.detail?.['ratio']).toBeCloseTo(4200 / 3000, 9);
  });

  it('API 610 NPS 6 top nozzle with the grade B table: Fz limit 2 x 700 = 1400, 1500 lbf is 1.071429 and refused; the detail carries every component', () => {
    const table = reference.api610_table5_nps6_usc;
    const result = run('nozzle_load_check', {
      standard: 'api610',
      nominalIn: 6,
      orientation: 'top',
      forceLbf: [300, 200, 1500],
      momentFtLbf: [0, 0, 0],
      table: { source: table.source, forcesLbf: table.forcesLbf, momentsFtLbf: table.momentsFtLbf },
    });
    expect(result.error?.code).toBe('PST_NOZZLE_OVERLOAD');
    const components = result.error?.detail?.['components'] as { name: string; ratio: number; limit: number }[];
    const fz = components.find((entry) => entry.name === 'Fz');
    expect(fz?.limit).toBe(1400);
    expect(Math.abs((fz?.ratio as number) - 1.071429)).toBeLessThan(1.071429e-6);
    expect(components.find((entry) => entry.name === 'Fx')?.ratio).toBeCloseTo(300 / 1120, 12);
    expect(components.find((entry) => entry.name === 'My')?.ratio).toBe(0);
    expect(result.error?.detail?.['unverified']).toHaveLength(1);
  });

  it('API 610 within the limit: the component ratios, the unverified table and the resultant warning', () => {
    const table = reference.api610_table5_nps6_usc;
    const result = run('nozzle_load_check', {
      standard: 'api610',
      orientation: 'end',
      forceLbf: [700, 560, 460],
      momentFtLbf: [1700, 870, 1300],
      table: { source: table.source, forcesLbf: table.forcesLbf, momentsFtLbf: table.momentsFtLbf },
    });
    expect(data(result)['ratio']).toBeCloseTo(0.5, 12);
    expect((data(result)['warnings'] as { code: string }[]).map((w) => w.code)).toEqual(['PST_NOZZLE_LIMIT_UNVERIFIED']);
    expect(data(result)['grade']).toBe('B');
  });

  it('user limits (grade C) per component and resultant, in the units of the loads', () => {
    const result = run('nozzle_load_check', {
      standard: 'user',
      forceN: [3000, 4000, 0],
      momentNm: [0, 0, 100],
      userLimits: { source: 'vendor letter 7', resultantForce: 10000, moments: { Mx: 500, My: 500, Mz: 200 } },
    });
    expect(data(result)['ratio']).toBeCloseTo(0.5, 12);
    expect(data(result)['grade']).toBe('C');
    expect(data(result)['unit']).toBe('N, N.m');
  });

  it('refuses missing inputs with a code: nominalIn, table, orientation, row, userLimits, mixed units, both force units', () => {
    const code = (params: Record<string, unknown>): string | undefined => run('nozzle_load_check', params).error?.code;
    const load = { forceLbf: [1, 0, 0], momentFtLbf: [0, 0, 0] };
    expect(code({ standard: 'nema_sm23', ...load })).toBe('PST_PARAM_INVALID');
    expect(code({ standard: 'api610', ...load })).toBe('PST_NOZZLE_LIMIT_MISSING');
    expect(
      code({
        standard: 'api610',
        orientation: 'side',
        ...load,
        table: { source: 's', forcesLbf: {}, momentsFtLbf: { Mx: 1, My: 1, Mz: 1 } },
      }),
    ).toBe('PST_NOZZLE_LIMIT_MISSING');
    expect(code({ standard: 'user', ...load })).toBe('PST_NOZZLE_LIMIT_MISSING');
    expect(code({ standard: 'user', ...load, userLimits: { source: 's' } })).toBe('PST_NOZZLE_LIMIT_MISSING');
    expect(code({ standard: 'nema_sm23', nominalIn: 6, forceLbf: [1, 0, 0], momentNm: [0, 0, 0] })).toBe('PST_PARAM_INVALID');
    expect(code({ standard: 'nema_sm23', nominalIn: 6, forceLbf: [1, 0, 0], forceN: [1, 0, 0], momentFtLbf: [0, 0, 0] })).toBe(
      'PST_PARAM_INVALID',
    );
    expect(code({ standard: 'nema_sm23', nominalIn: 6, forceLbf: [1, 0, 0] })).toBe('PST_PARAM_INVALID');
    expect(code({ standard: 'nema_sm23', nominalIn: 6, forceLbf: [Number.NaN, 0, 0], momentFtLbf: [0, 0, 0] })).toBe('CMD_INVALID_PARAMS');
  });

  it('is pure: the document is returned as given', () => {
    const before = JSON.stringify(doc);
    const result = run('nozzle_load_check', { standard: 'nema_sm23', nominalIn: 6, forceLbf: [1, 0, 0], momentFtLbf: [0, 0, 0] });
    expect(result.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
