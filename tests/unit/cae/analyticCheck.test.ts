/** analytic_check (05 FR-FEA-21, AF-35): the closed forms against validation/fea_analytic_expected.json (VC-FEA-10..14). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

interface Expected {
  readonly cases: readonly { id: string; value: number; tolerance_rel?: number }[];
}
const expected = JSON.parse(readFileSync('docs/aerospace/05-fea-cae-handoff/validation/fea_analytic_expected.json', 'utf8')) as Expected;
const reference = (id: string): number => expected.cases.find((entry) => entry.id === id)?.value ?? Number.NaN;

interface Data {
  results: { name: string; value: number; unit: string; formula: string }[];
  comparison: Record<string, unknown> | null;
  assumptions: string[];
  sources: string[];
}
const doc = createEmptyDocument();
const check = (name: string, inputs: Record<string, number>, compare?: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'hand_check', { check: name, inputs, ...(compare === undefined ? {} : { compare }) });
const valueOf = (result: ReturnType<typeof execute>, name: string): number =>
  (result.data as Data).results.find((entry) => entry.name === name)?.value ?? Number.NaN;

const BEAMP = { P_N: 9, L_mm: 8, E_MPa: 210000, b_mm: 1, h_mm: 1 };

describe('analytic_check closed forms (validation pack)', () => {
  it('cantilever: tip deflection 0.0877714 mm (VC-FEA-10.a), with Timoshenko 0.0888411 (10.b), root stress 432 MPa (10.c), M(0) = 72 N.mm', () => {
    const plain = check('cantilever', BEAMP);
    expect(valueOf(plain, 'tip_deflection_mm')).toBeCloseTo(reference('VC-FEA-10.a'), 6);
    expect(valueOf(plain, 'root_bending_stress_MPa')).toBeCloseTo(reference('VC-FEA-10.c'), 9);
    expect(valueOf(plain, 'root_bending_moment_Nmm')).toBe(72);
    expect(valueOf(plain, 'tip_stiffness_N_per_mm')).toBeCloseTo(9 / valueOf(plain, 'tip_deflection_mm'), 9);
    expect((plain.data as Data).results.map((entry) => entry.name)).not.toContain('tip_deflection_timoshenko_mm');
    const shear = check('cantilever', { ...BEAMP, nu: 0.3 });
    expect(valueOf(shear, 'tip_deflection_timoshenko_mm')).toBeCloseTo(reference('VC-FEA-10.b'), 6);
  });

  it('cantilever_frequency: weak axis 13096.7 Hz and strong axis 19645.1 Hz (VC-FEA-11.a / b), 2nd mode 82075.8 Hz (11.c)', () => {
    const base = { E_MPa: 210000, rho_t_per_mm3: 7.8e-9, b_mm: 1, h_mm: 1.5, L_mm: 8 };
    const first = check('cantilever_frequency', base);
    expect(valueOf(first, 'frequency_weak_axis_Hz')).toBeCloseTo(reference('VC-FEA-11.a'), 0);
    expect(valueOf(first, 'frequency_strong_axis_Hz')).toBeCloseTo(reference('VC-FEA-11.b'), 0);
    expect(valueOf(first, 'mode_beta_L')).toBe(1.8751040687);
    const second = check('cantilever_frequency', { ...base, mode: 2 });
    expect(valueOf(second, 'frequency_weak_axis_Hz')).toBeCloseTo(reference('VC-FEA-11.c'), -1);
  });

  it('euler_column: fixed-free 20 x 10 x 500 mm, E 70 GPa -> 1151.45 N (VC-FEA-12); the effective-length factor scales it', () => {
    const column = { L_mm: 500, E_MPa: 70000, b_mm: 20, h_mm: 10, K: 2 };
    const fixedFree = check('euler_column', column);
    expect(valueOf(fixedFree, 'critical_load_N')).toBeCloseTo(reference('VC-FEA-12'), 1);
    expect(valueOf(fixedFree, 'second_moment_min_mm4')).toBeCloseTo((20 * 10 ** 3) / 12, 9);
    expect(valueOf(fixedFree, 'critical_stress_MPa')).toBeCloseTo(valueOf(fixedFree, 'critical_load_N') / 200, 9);
    expect(valueOf(check('euler_column', { ...column, K: 1 }), 'critical_load_N')).toBeCloseTo(
      4 * valueOf(fixedFree, 'critical_load_N'),
      6,
    );
    expect(valueOf(fixedFree, 'slenderness_ratio')).toBeCloseTo((2 * 500) / Math.sqrt(10 ** 2 / 12), 6);
  });

  it('ss_plate_buckling: 600 x 200 x 2 mm aluminium plate -> k = 4, m = 3, 25.8434 MPa (VC-FEA-13)', () => {
    const plate = check('ss_plate_buckling', { E_MPa: 70000, nu: 0.33, t_mm: 2, a_mm: 600, b_mm: 200 });
    expect(valueOf(plate, 'buckling_coefficient_k')).toBeCloseTo(4, 9);
    expect(valueOf(plate, 'half_waves_m')).toBe(3);
    expect(valueOf(plate, 'critical_stress_MPa')).toBeCloseTo(reference('VC-FEA-13'), 3);
  });

  it('kirsch_kt: gross Kt = 3 (VC-FEA-14), profile along y and hoop stress on the edge scale with the remote stress', () => {
    const base = check('kirsch_kt', {});
    expect(valueOf(base, 'Kt_gross')).toBe(reference('VC-FEA-14'));
    const loaded = check('kirsch_kt', { S_MPa: 100, y_over_a: 2, theta_deg: 90 });
    expect(valueOf(loaded, 'stress_at_hole_edge_MPa')).toBe(300);
    expect(valueOf(loaded, 'sigma_xx_at_y_MPa')).toBeCloseTo(100 * (1 + 0.5 / 4 + 1.5 / 16), 9);
    expect(valueOf(loaded, 'hoop_stress_at_theta_MPa')).toBeCloseTo(300, 9);
    expect(valueOf(check('kirsch_kt', { theta_deg: 0 }), 'hoop_stress_at_theta_MPa')).toBeCloseTo(-1, 9);
  });

  it('ss_beam: central load, uniform load and their sum', () => {
    const base = { L_mm: 100, E_MPa: 200000, b_mm: 10, h_mm: 10 };
    const inertia = (10 * 10 ** 3) / 12;
    const point = check('ss_beam', { ...base, P_N: 1000 });
    expect(valueOf(point, 'midspan_deflection_mm')).toBeCloseTo((1000 * 100 ** 3) / (48 * 200000 * inertia), 9);
    expect(valueOf(point, 'midspan_bending_moment_Nmm')).toBe(25000);
    expect(valueOf(point, 'midspan_bending_stress_MPa')).toBeCloseTo((25000 * 5) / inertia, 9);
    expect(valueOf(point, 'support_reaction_N')).toBe(500);
    const uniform = check('ss_beam', { ...base, w_N_per_mm: 10 });
    expect(valueOf(uniform, 'midspan_deflection_mm')).toBeCloseTo((5 * 10 * 100 ** 4) / (384 * 200000 * inertia), 9);
    expect(valueOf(uniform, 'midspan_bending_moment_Nmm')).toBe(12500);
    const both = check('ss_beam', { ...base, P_N: 1000, w_N_per_mm: 10 });
    expect(valueOf(both, 'midspan_bending_moment_Nmm')).toBe(37500);
    expect(valueOf(both, 'support_reaction_N')).toBe(1000);
  });
});

describe('analytic_check output contract', () => {
  it('returns units, formulas, assumptions and sources (AF-35) and is read-only', () => {
    const result = check('cantilever', BEAMP);
    const data = result.data as Data;
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(data.results.every((entry) => entry.unit.length > 0 && entry.formula.length > 0)).toBe(true);
    expect(data.assumptions.length).toBeGreaterThan(0);
    expect(data.sources).toEqual(['S20', 'S30']);
    expect(result.summary).toContain('tip_deflection_mm = 0.0877714 mm');
    expect(execute(doc, 'hand_check', { check: 'cantilever', inputs: BEAMP }).data).toEqual(result.data);
  });

  it('compare reports the relative difference and, with a tolerance, whether it is within', () => {
    const near = check('cantilever', BEAMP, { quantity: 'tip_deflection_mm', value: 0.0876111, toleranceRel: 0.02 });
    expect((near.data as Data).comparison).toMatchObject({
      quantity: 'tip_deflection_mm',
      unit: 'mm',
      fe: 0.0876111,
      toleranceRel: 0.02,
      withinTolerance: true,
    });
    expect(Number((near.data as Data).comparison?.['relativeDifference'])).toBeCloseTo(-0.001826, 5);
    expect(near.summary).toContain('within tolerance');
    const far = check('cantilever', BEAMP, { quantity: 'tip_deflection_mm', value: 0.1, toleranceRel: 0.02 });
    expect((far.data as Data).comparison?.['withinTolerance']).toBe(false);
    expect(far.summary).toContain('OUTSIDE tolerance');
    const untested = check('cantilever', BEAMP, { quantity: 'tip_deflection_mm', value: 0.1 });
    expect((untested.data as Data).comparison?.['withinTolerance']).toBeNull();
  });
});

describe('analytic_check refusals', () => {
  const refused = (result: ReturnType<typeof execute>, text: string): void => {
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FEA_ANALYTIC_INPUT_INVALID');
    expect(result.error?.remediation.length).toBeGreaterThan(0);
    expect(result.summary).toContain(text);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  };

  it('refuses a missing, unknown, non-positive, out-of-range or non-integer input', () => {
    refused(check('cantilever', { P_N: 9 }), 'cantilever needs L_mm, E_MPa, b_mm, h_mm');
    refused(check('cantilever', { ...BEAMP, speed: 3 }), 'does not use speed');
    refused(check('cantilever', { ...BEAMP, L_mm: 0 }), 'L_mm = 0 is outside its range > 0');
    refused(check('cantilever', { ...BEAMP, nu: 0.5 }), 'nu = 0.5 is outside its range (-1, 0.5)');
    refused(
      check('cantilever_frequency', { E_MPa: 1, rho_t_per_mm3: 1, b_mm: 1, h_mm: 1, L_mm: 1, mode: 7 }),
      'mode = 7 is outside its range [1, 6]',
    );
    refused(check('cantilever_frequency', { E_MPa: 1, rho_t_per_mm3: 1, b_mm: 1, h_mm: 1, L_mm: 1, mode: 1.5 }), 'mode must be an integer');
    refused(check('kirsch_kt', { y_over_a: 0.5 }), 'y_over_a = 0.5 is outside');
  });

  it('ss_beam needs a load, and compare must name a result of the check', () => {
    refused(check('ss_beam', { L_mm: 10, E_MPa: 1, b_mm: 1, h_mm: 1 }), 'needs at least one of P_N, w_N_per_mm');
    refused(check('cantilever', BEAMP, { quantity: 'speed', value: 1 }), "has no result 'speed'");
  });

  it('rejects an unknown check through the schema', () => {
    const result = execute(doc, 'hand_check', { check: 'truss', inputs: {} });
    expect(result.rejected).toBe(true);
  });
});
