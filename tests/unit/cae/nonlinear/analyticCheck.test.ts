/**
 * nonlinear_analytic_check against the frozen oracles of docs/physics/05-nonlinear-structural/validation/expected_results.json (VC-NLS-10, 30, 40, 50),
 * which generate_nls_reference.py computes from textbook closed forms (elastica: Bisshopp & Drucker 1945; limit analysis: Hill; column: Timoshenko & Gere).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

interface Oracle {
  readonly id: string;
  readonly value: number;
  readonly tolerance: { readonly rel?: number; readonly abs?: number };
}

const ORACLES = new Map(
  (
    JSON.parse(readFileSync('docs/physics/05-nonlinear-structural/validation/expected_results.json', 'utf8')) as { cases: Oracle[] }
  ).cases.map((entry) => [entry.id, entry]),
);

const oracle = (id: string): Oracle => {
  const found = ORACLES.get(id);
  if (found === undefined) throw new Error(`no oracle ${id}`);
  return found;
};

const doc = createEmptyDocument();

type Values = Record<string, { value: number; unit: string }>;

function check(name: string, inputs: Record<string, unknown>): { values: Values; data: Record<string, unknown>; summary: string } {
  const result = execute(doc, 'nonlinear_analytic_check', { check: name, inputs });
  expect(result.rejected, result.summary).not.toBe(true);
  const data = result.data as Record<string, unknown>;
  return { values: data['values'] as Values, data, summary: result.summary };
}

/** Within the oracle tolerance (relative, else absolute); both are tighter than the FE gates the oracle belongs to. */
function expectOracle(actual: number, id: string): void {
  const { value, tolerance } = oracle(id);
  const allowed = tolerance.abs ?? Math.abs(value) * Math.min(tolerance.rel ?? 1e-9, 1e-6);
  expect(Math.abs(actual - value), `${id}: ${actual} vs ${value}`).toBeLessThanOrEqual(Math.max(allowed, 1e-9 * Math.abs(value)));
}

const REFUSALS = (command: string, params: Record<string, unknown>): { code: string; unchanged: boolean } => {
  const result = execute(doc, command, params);
  expect(result.rejected, result.summary).toBe(true);
  expect(result.affected).toEqual([]);
  return { code: result.error?.code ?? '', unchanged: result.document === doc };
};

const SECTION = { b_mm: 10, h_mm: 20, sigmaY_MPa: 250, L_mm: 500 };

describe('plastic_hinge_beam (VC-NLS-40.a-d)', () => {
  it('gives the plastic moment and the virtual-work collapse load of the four supports', () => {
    expectOracle(check('plastic_hinge_beam', { support: 'cantilever', ...SECTION }).values['plasticMoment']?.value ?? 0, 'VC-NLS-40.a');
    const load = (support: string): number => check('plastic_hinge_beam', { support, ...SECTION }).values['collapseLoad']?.value ?? 0;
    expectOracle(load('cantilever'), 'VC-NLS-40.b');
    expectOracle(load('propped_cantilever'), 'VC-NLS-40.c');
    expectOracle(load('fixed_fixed'), 'VC-NLS-40.d');
    expect(load('simply_supported')).toBeCloseTo((4 * 250000) / 500, 9);
    const { values } = check('plastic_hinge_beam', { support: 'cantilever', ...SECTION });
    expect(values['yieldMoment']).toEqual({ value: (250 * 10 * 400) / 6, unit: 'N*mm' });
    expect(values['shapeFactor']?.value).toBe(1.5);
  });

  it('converts { value, unit } inputs and warns for fixed-fixed', () => {
    const { values, data } = check('plastic_hinge_beam', {
      support: 'fixed_fixed',
      b_mm: { value: 1, unit: 'cm' },
      h_mm: 20,
      sigmaY_MPa: { value: 0.25, unit: 'GPa' },
      L_mm: { value: 0.5, unit: 'm' },
    });
    expectOracle(values['collapseLoad']?.value ?? 0, 'VC-NLS-40.d');
    expect(String((data['warnings'] as string[])[0])).toContain('membrane');
  });

  it('refuses missing, invalid and unknown inputs with stable codes and leaves the document alone', () => {
    expect(REFUSALS('nonlinear_analytic_check', { check: 'plastic_hinge_beam', inputs: SECTION })).toEqual({
      code: 'NLS_INPUT_MISSING',
      unchanged: true,
    });
    expect(REFUSALS('nonlinear_analytic_check', { check: 'plastic_hinge_beam', inputs: { support: 'roller', ...SECTION } }).code).toBe(
      'NLS_INPUT_INVALID',
    );
    expect(
      REFUSALS('nonlinear_analytic_check', { check: 'plastic_hinge_beam', inputs: { support: 'cantilever', ...SECTION, L_mm: 0 } }).code,
    ).toBe('NLS_INPUT_INVALID');
    expect(
      REFUSALS('nonlinear_analytic_check', {
        check: 'plastic_hinge_beam',
        inputs: { support: 'cantilever', ...SECTION, h_mm: { value: 2, unit: 'N' } },
      }).code,
    ).toBe('NLS_INPUT_INVALID');
    expect(
      REFUSALS('nonlinear_analytic_check', { check: 'plastic_hinge_beam', inputs: { support: 'cantilever', ...SECTION, L_mm: 'long' } })
        .code,
    ).toBe('NLS_INPUT_INVALID');
    expect(REFUSALS('nonlinear_analytic_check', { check: 'nope', inputs: {} }).code).toBe('CMD_INVALID_PARAMS');
  });
});

describe('moment_curvature_rectangle (VC-NLS-40.e)', () => {
  it('M/My = kappa/kappa_y below yield and 1.5 (1 - (kappa_y/kappa)^2/3) above', () => {
    expectOracle(check('moment_curvature_rectangle', { kappaOverKappaY: 2 }).values['momentOverYieldMoment']?.value ?? 0, 'VC-NLS-40.e');
    expect(check('moment_curvature_rectangle', { kappaOverKappaY: 0.5 }).values['momentOverYieldMoment']?.value).toBe(0.5);
    expect(check('moment_curvature_rectangle', { kappaOverKappaY: 1 }).values['momentOverYieldMoment']?.value).toBe(1);
    expect(check('moment_curvature_rectangle', { kappaOverKappaY: 1e6 }).values['momentOverYieldMoment']?.value).toBeCloseTo(1.5, 9);
  });

  it('adds the absolute moment and yield curvature when the section (and E) is given', () => {
    const { values } = check('moment_curvature_rectangle', { kappaOverKappaY: 2, b_mm: 10, h_mm: 20, sigmaY_MPa: 250, E_MPa: 200000 });
    expect(values['moment']?.value).toBeCloseTo((1.375 * (250 * 10 * 400)) / 6, 6);
    expect(values['yieldCurvature']).toEqual({ value: 500 / (200000 * 20), unit: '1/mm' });
  });

  it('refuses a partial section, E without a section and a non-positive ratio', () => {
    expect(
      REFUSALS('nonlinear_analytic_check', { check: 'moment_curvature_rectangle', inputs: { kappaOverKappaY: 2, b_mm: 10 } }).code,
    ).toBe('NLS_INPUT_MISSING');
    expect(
      REFUSALS('nonlinear_analytic_check', { check: 'moment_curvature_rectangle', inputs: { kappaOverKappaY: 2, E_MPa: 2e5 } }).code,
    ).toBe('NLS_INPUT_INVALID');
    expect(REFUSALS('nonlinear_analytic_check', { check: 'moment_curvature_rectangle', inputs: { kappaOverKappaY: 0 } }).code).toBe(
      'NLS_INPUT_INVALID',
    );
    expect(REFUSALS('nonlinear_analytic_check', { check: 'moment_curvature_rectangle', inputs: {} }).code).toBe('NLS_INPUT_MISSING');
  });
});

describe('thick_cylinder_pressure (VC-NLS-30.a-e)', () => {
  const tube = { a_mm: 100, b_mm: 200, sigmaY_MPa: 207.9, nu: 0.3 };

  it('gives Tresca and von Mises first-yield and collapse pressures and the pressure at a plastic radius', () => {
    const { values } = check('thick_cylinder_pressure', { ...tube, c_mm: 150 });
    expectOracle(values['misesFirstYieldPressure']?.value ?? 0, 'VC-NLS-30.a');
    expectOracle(values['misesCollapsePressure']?.value ?? 0, 'VC-NLS-30.b');
    expectOracle(values['trescaCollapsePressure']?.value ?? 0, 'VC-NLS-30.c');
    expectOracle(values['trescaFirstYieldPressure']?.value ?? 0, 'VC-NLS-30.d');
    expectOracle(values['misesPressureAtPlasticRadius']?.value ?? 0, 'VC-NLS-30.e');
    // c = b: the plastic zone reaches the outer radius = the collapse pressure of each criterion
    const full = check('thick_cylinder_pressure', { ...tube, c_mm: 200 }).values;
    expect(full['trescaPressureAtPlasticRadius']?.value).toBeCloseTo(full['trescaCollapsePressure']?.value ?? 0, 9);
    expect(full['misesPressureAtPlasticRadius']?.value).toBeCloseTo(full['misesCollapsePressure']?.value ?? 0, 9);
  });

  it('refuses b <= a, a plastic radius outside the wall and nu >= 0.5', () => {
    const run = (inputs: Record<string, unknown>): string =>
      REFUSALS('nonlinear_analytic_check', { check: 'thick_cylinder_pressure', inputs }).code;
    expect(run({ ...tube, b_mm: 100 })).toBe('NLS_INPUT_INVALID');
    expect(run({ ...tube, c_mm: 250 })).toBe('NLS_INPUT_INVALID');
    expect(run({ ...tube, c_mm: 50 })).toBe('NLS_INPUT_INVALID');
    expect(run({ ...tube, nu: 0.5 })).toBe('NLS_INPUT_INVALID');
    expect(run({ a_mm: 100 })).toBe('NLS_INPUT_MISSING');
  });
});

describe('elastica_cantilever (VC-NLS-10.a-d)', () => {
  it('matches the elliptic-integral oracle to the generator precision', () => {
    expectOracle(check('elastica_cantilever', { lambda: 1 }).values['deltaVOverL']?.value ?? 0, 'VC-NLS-10.a');
    expectOracle(check('elastica_cantilever', { lambda: 2 }).values['deltaVOverL']?.value ?? 0, 'VC-NLS-10.b');
    expectOracle(check('elastica_cantilever', { lambda: 10 }).values['deltaVOverL']?.value ?? 0, 'VC-NLS-10.c');
    expectOracle(check('elastica_cantilever', { lambda: 2 }).values['deltaHOverL']?.value ?? 0, 'VC-NLS-10.d');
    expect(check('elastica_cantilever', { lambda: 1 }).values['deltaVOverL']?.value).toBeCloseTo(0.30172077, 6);
  });

  it('tends to the linear theory lambda/3 for a small load and refuses lambda <= 0', () => {
    const { values } = check('elastica_cantilever', { lambda: 0.01 });
    expect(values['deltaVOverL']?.value).toBeCloseTo(values['linearDeltaVOverL']?.value ?? 0, 4);
    expect(REFUSALS('nonlinear_analytic_check', { check: 'elastica_cantilever', inputs: { lambda: 0 } }).code).toBe('NLS_INPUT_INVALID');
    expect(REFUSALS('nonlinear_analytic_check', { check: 'elastica_cantilever', inputs: {} }).code).toBe('NLS_INPUT_MISSING');
  });
});

describe('imperfect_column (VC-NLS-50.a-c)', () => {
  const column = { E_MPa: 70000, L_mm: 500, w0_mm: 0.5, b_mm: 20, h_mm: 10 };

  it('gives the Euler load and the amplified deflection', () => {
    expectOracle(check('imperfect_column', { ...column, PoverPcr: 0.5 }).values['eulerLoad']?.value ?? 0, 'VC-NLS-50.a');
    expectOracle(check('imperfect_column', { ...column, PoverPcr: 0.5 }).values['additionalDeflection']?.value ?? 0, 'VC-NLS-50.b');
    expectOracle(check('imperfect_column', { ...column, PoverPcr: 0.8 }).values['additionalDeflection']?.value ?? 0, 'VC-NLS-50.c');
    const critical = check('imperfect_column', { ...column, PoverPcr: 0 }).values['eulerLoad']?.value ?? 0;
    const byLoad = check('imperfect_column', { ...column, P_N: critical / 2 });
    expect(byLoad.values['amplification']?.value).toBeCloseTo(2, 9);
    expect(
      check('imperfect_column', { E_MPa: 70000, L_mm: 500, w0_mm: 0.5, I_mm4: (20 * 1000) / 12, PoverPcr: 0.5 }).values['eulerLoad']?.value,
    ).toBeCloseTo(critical, 6);
  });

  it('refuses a load at or above the Euler load, both or neither load inputs, and a missing section', () => {
    const run = (inputs: Record<string, unknown>): string =>
      REFUSALS('nonlinear_analytic_check', { check: 'imperfect_column', inputs }).code;
    expect(run({ ...column, PoverPcr: 1 })).toBe('NLS_INPUT_INVALID');
    expect(run({ ...column, P_N: 1e9 })).toBe('NLS_INPUT_INVALID');
    expect(run({ ...column, PoverPcr: 0.5, P_N: 10 })).toBe('NLS_INPUT_INVALID');
    expect(run(column)).toBe('NLS_INPUT_INVALID');
    expect(run({ E_MPa: 70000, L_mm: 500, w0_mm: 0.5, PoverPcr: 0.5 })).toBe('NLS_INPUT_MISSING');
  });
});

describe('nonlinear_analytic_check envelope', () => {
  it('is read-only and pure: the document is returned as is and carries formula, source and inputs', () => {
    const before = JSON.stringify(doc);
    const result = execute(doc, 'nonlinear_analytic_check', { check: 'elastica_cantilever', inputs: { lambda: 1 } });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.data).toMatchObject({ check: 'elastica_cantilever', inputs: { lambda: 1 } });
    expect(String((result.data as { formula: string }).formula)).toContain('alpha L');
    expect(String((result.data as { source: string }).source)).toContain('Bisshopp');
  });
});
