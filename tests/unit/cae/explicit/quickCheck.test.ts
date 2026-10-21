/** explicit_quick_check against the validation pack's expected_results.json (VC-EXP-10, 11, 12, 20, 21). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { code, data } from './support';

const PACK = path.resolve(__dirname, '../../../../docs/physics/19-explicit-impact/validation');
const expected = new Map(
  (JSON.parse(readFileSync(`${PACK}/expected_results.json`, 'utf8')) as { cases: { id: string; value: number }[] }).cases.map((entry) => [
    entry.id,
    entry.value,
  ]),
);
const doc = createEmptyDocument();
const quick = (check: string, inputs: Record<string, number>): Record<string, number> =>
  data<{ values: Record<string, number> }>(execute(doc, 'hand_check', { check, inputs })).values;
const close = (actual: number | undefined, id: string): void => {
  const value = expected.get(id) ?? Number.NaN;
  expect(Math.abs((actual ?? Number.NaN) / value - 1)).toBeLessThan(1e-9);
};
const STEEL = { E_Pa: 2e11, nu: 0.3, rho_kg_m3: 7850 };
const TI = { A_Pa: 1098e6, B_Pa: 1092e6, n: 0.93, C: 0.014, m: 1.1, eps_p: 0.1, rate_per_s: 1000, ref_rate_per_s: 1 };

describe('hand_check', () => {
  it('matches the generator for wave speeds, time step and mass scaling (VC-EXP-10, 11)', () => {
    const waves = quick('wave_speed', STEEL);
    close(waves['c0_m_s'], 'VC-EXP-10.a');
    close(waves['cd_m_s'], 'VC-EXP-10.b');
    close(quick('critical_time_step', { ...STEEL, L_e_m: 0.002 })['dt_s'], 'VC-EXP-11.a');
    close(quick('mass_scaling', { ...STEEL, L_e_m: 0.002, dt_target_s: 1e-6 })['added_mass_ratio'], 'VC-EXP-11.b');
  });

  it('matches the generator for bar impact (VC-EXP-12)', () => {
    const bar = quick('bar_impact', { E_Pa: 2e11, rho_kg_m3: 7850, v_m_s: 10, L_m: 0.2, sigma_y_Pa: 5e8 });
    close(bar['sigma_wall_Pa'], 'VC-EXP-12.a');
    close(bar['contact_duration_s'], 'VC-EXP-12.b');
    close(bar['sigma_two_bars_Pa'], 'VC-EXP-12.c');
    close(bar['v_yield_m_s'], 'VC-EXP-12.d');
    expect(quick('bar_impact', { E_Pa: 2e11, rho_kg_m3: 7850, v_m_s: 10, L_m: 0.2 })['v_yield_m_s']).toBeUndefined();
  });

  it('matches the generator for Johnson-Cook flow and failure (VC-EXP-20, 21)', () => {
    close((quick('johnson_cook_flow', TI)['sigma_y_Pa'] ?? 0) / 1e6, 'VC-EXP-20.a');
    close((quick('johnson_cook_flow', { ...TI, T_K: 600, Tm_K: 1900, Tr_K: 293 })['sigma_y_Pa'] ?? 0) / 1e6, 'VC-EXP-20.b');
    expect(quick('johnson_cook_flow', { ...TI, rate_per_s: 0.001 })['rate_term']).toBe(1);
    const failure = quick('johnson_cook_failure', {
      D1: 0.05,
      D2: 3.44,
      D3: -2.12,
      D4: 0.002,
      D5: 0.61,
      triaxiality: 1 / 3,
      rate_per_s: 1,
      ref_rate_per_s: 1,
    });
    close(failure['eps_f'], 'VC-EXP-21.a');
  });

  it('refuses a missing input and is read-only', () => {
    const result = execute(doc, 'hand_check', { check: 'bar_impact', inputs: { E_Pa: 1 } });
    expect(code(result)).toBe('EXP_INPUT_MISSING');
    expect(result.summary).toContain('rho_kg_m3, v_m_s, L_m');
    expect(execute(doc, 'hand_check', { check: 'wave_speed', inputs: STEEL }).document).toBe(doc);
  });
});
