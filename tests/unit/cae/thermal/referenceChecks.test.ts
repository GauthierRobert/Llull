/** Engineering-audit fixes of the thermal reference checks: fin heat rate / tip temperature, general lumped body, steady labels, target warnings. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { must, thermalFixture } from './fixtures';

type Q = { value: number; unit: string };
const q = (value: number, unit: string): Q => ({ value, unit });
interface Data {
  outputs: Record<string, Q>;
  validity?: { Bi: number; ok: boolean };
}
const check = (
  name: string,
  inputs: Record<string, Q>,
): { data: Data; summary: string; rejected: boolean; error: { code: string } | undefined } => {
  const result = execute(createEmptyDocument(), 'thermal_analytic_check', { check: name, inputs });
  return { data: result.data as Data, summary: result.summary, rejected: result.rejected === true, error: result.error };
};

/** Incropera Table 3.4 written with exponentials (independent of cosh / sinh / tanh). */
const cosh = (x: number): number => (Math.exp(x) + Math.exp(-x)) / 2;
const sinh = (x: number): number => (Math.exp(x) - Math.exp(-x)) / 2;

const without = (inputs: Record<string, Q>, ...names: string[]): Record<string, Q> =>
  Object.fromEntries(Object.entries(inputs).filter(([name]) => !names.includes(name)));

const PIN = { h: q(100, 'W/(m^2*K)'), k: q(398, 'W/(m*K)'), d: q(5, 'mm'), L: q(0.1, 'm'), Tb: q(100, 'degC'), Tinf: q(25, 'degC') };

describe('fin: heat rate and tip temperature (Incropera Table 3.4)', () => {
  const area = (Math.PI * 0.005 ** 2) / 4;
  const perimeter = Math.PI * 0.005;
  const m = Math.sqrt((100 * perimeter) / (398 * area));
  const bigM = Math.sqrt(100 * perimeter * 398 * area) * 75;
  const b = 100 / (m * 398);
  const ml = m * 0.1;

  it('adiabatic tip: Q = M tanh(mL), theta(L)/theta_b = 1/cosh(mL)', () => {
    const { data, summary } = check('fin', PIN);
    expect(data.outputs['Q']?.unit).toBe('W');
    expect(data.outputs['Q']?.value).toBeCloseTo((bigM * sinh(ml)) / cosh(ml), 9);
    expect(data.outputs['tip_ratio']?.value).toBeCloseTo(1 / cosh(ml), 12);
    expect(data.outputs['T_tip']?.unit).toBe('degC');
    expect(data.outputs['T_tip']?.value).toBeCloseTo(25 + 75 / cosh(ml), 9);
    expect(summary).toContain('Q = ');
  });

  it('convective tip (exact) and corrected length agree to a few percent', () => {
    const { data } = check('fin', PIN);
    const exact = (bigM * (sinh(ml) + b * cosh(ml))) / (cosh(ml) + b * sinh(ml));
    expect(data.outputs['Q_convective_tip']?.value).toBeCloseTo(exact, 9);
    expect(data.outputs['tip_ratio_convective']?.value).toBeCloseTo(1 / (cosh(ml) + b * sinh(ml)), 12);
    expect(data.outputs['Lc']?.value).toBeCloseTo(0.1 + 0.005 / 4, 12);
    const corrected = data.outputs['Q_corrected']?.value ?? 0;
    expect(Math.abs(corrected - exact) / exact).toBeLessThan(0.01);
    expect(exact).toBeGreaterThan(data.outputs['Q']?.value ?? Infinity);
  });

  it('accepts P and A for any section and gives the same result as d', () => {
    const rest = without(PIN, 'd');
    const general = check('fin', { ...rest, P: q(Math.PI * 0.005, 'm'), A: q((Math.PI * 0.005 ** 2) / 4, 'm^2') });
    expect(general.data.outputs['Q']?.value).toBeCloseTo(check('fin', PIN).data.outputs['Q']?.value ?? 0, 9);
  });

  it('efficiency only without Tb and Tinf; refuses a half-given base or section', () => {
    const geometry = without(PIN, 'Tb', 'Tinf');
    expect(check('fin', geometry).data.outputs['Q']).toBeUndefined();
    expect(check('fin', { ...geometry, Tb: PIN.Tb }).error?.code).toBe('THM_INPUT_INVALID');
    const noSection = without(PIN, 'd');
    expect(check('fin', noSection).error?.code).toBe('THM_INPUT_INVALID');
    expect(check('fin', { ...noSection, P: q(0.0157, 'm') }).error?.code).toBe('THM_INPUT_INVALID');
  });
});

describe('lumped: any shape via V / As', () => {
  const base = { rho: q(2700, 'kg/m^3'), c: q(900, 'J/(kg*K)'), k: q(200, 'W/(m*K)'), h: q(50, 'W/(m^2*K)') };
  const times = { Ti: q(300, 'degC'), Tinf: q(20, 'degC'), t: q(60, 's') };

  it('a cube of side a has Lc = a/6 and matches the equal-Lc sphere', () => {
    const a = 0.06;
    const cube = check('lumped', { ...base, ...times, V: q(a ** 3, 'm^3'), As: q(6 * a * a, 'm^2') });
    const sphere = check('lumped', { ...base, ...times, d: q(0.06, 'm') });
    expect(cube.data.outputs['Lc']?.value).toBeCloseTo(0.01, 12);
    expect(cube.data.outputs['Bi']?.value).toBeCloseTo((50 * 0.01) / 200, 12);
    expect(cube.data.outputs['T']?.value).toBeCloseTo(sphere.data.outputs['T']?.value ?? 0, 9);
    expect(cube.data.validity?.ok).toBe(true);
  });

  it('flags Bi >= 0.1 and refuses a body without a size', () => {
    const slab = check('lumped', { ...base, ...times, h: q(5000, 'W/(m^2*K)'), V: q(1e-3, 'm^3'), As: q(0.1, 'm^2') });
    expect(slab.data.validity?.ok).toBe(false);
    expect(slab.summary).toMatch(/WARNING: Bi = /);
    expect(check('lumped', { ...base, ...times }).error?.code).toBe('THM_INPUT_INVALID');
    expect(check('lumped', { ...base, ...times, V: q(1e-3, 'm^3') }).error?.code).toBe('THM_INPUT_INVALID');
  });
});

describe('define_property_model summary', () => {
  it('names a constant model instead of an empty range', () => {
    const created = must(createEmptyDocument(), 'create_material', {
      name: 'x',
      density: 0.008,
      color: '#999999',
      metalness: 1,
      roughness: 0.4,
    });
    const model = {
      id: 'k',
      property: 'k',
      unit: 'W/(m*K)',
      variables: [],
      validity: [],
      form: { kind: 'constant', value: 15 },
      basis: 'company',
      source: { citation: 'c' },
    };
    const summary = must(created.document, 'define_property_model', { material: 'x', model }).summary;
    expect(summary).toContain('as constant over no variable (constant) (basis company');
    expect(summary).not.toMatch(/over\s{2}/);
  });
});

describe('target far from the part', () => {
  const fixture = thermalFixture();
  const film = {
    name: 'f',
    kind: 'film',
    filmCoefficient: { value: 50, unit: 'W/(m^2*K)' },
    sinkTemperature: { value: 20, unit: 'degC' },
    source: { citation: 'test' },
  };
  it('warns in add_thermal_bc for a point 800 mm away, not for a point on the part', () => {
    const near = must(fixture.doc, 'add_thermal_bc', {
      analysisId: fixture.analysisId,
      ...film,
      target: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0]] },
    });
    expect(near.summary).not.toContain('WARNING');
    const far = must(fixture.doc, 'add_thermal_bc', {
      analysisId: fixture.analysisId,
      ...film,
      target: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.85]] },
    });
    expect(far.summary).toContain('WARNING: 1 target point(s) lie off the part');
    expect(far.affected).toHaveLength(1);
  });

  it('warns in add_fea_constraint and add_fea_load', () => {
    const constraint = must(fixture.doc, 'add_fea_constraint', {
      analysisId: fixture.analysisId,
      name: 'fix',
      kind: 'fixed',
      target: { entityId: fixture.boxId, facesNear: [[5, 0.5, 0.02]] },
    });
    expect(constraint.summary).toContain('WARNING');
    const load = must(fixture.doc, 'add_fea_load', {
      analysisId: fixture.analysisId,
      name: 'p',
      kind: 'pressure',
      magnitude: 1000,
      target: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.05]] },
    });
    expect(load.summary).not.toContain('WARNING');
  });
});

describe('target far from the part in update_* commands', () => {
  const fixture = thermalFixture();
  const far = { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.85]] };
  const near = { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0]] };

  it('update_fea_constraint and update_fea_load warn for a far target, not for a near one or without a target', () => {
    const fix = must(fixture.doc, 'add_fea_constraint', { analysisId: fixture.analysisId, name: 'fix', kind: 'fixed', target: near });
    const constraintId = fix.affected[0] ?? '';
    const moved = must(fix.document, 'update_fea_constraint', { analysisId: fixture.analysisId, constraintId, target: far });
    expect(moved.summary).toContain('WARNING: 1 target point(s) lie off the part');
    expect(moved.affected).toEqual([constraintId]);
    expect(
      must(fix.document, 'update_fea_constraint', { analysisId: fixture.analysisId, constraintId, target: near }).summary,
    ).not.toContain('WARNING');
    expect(
      must(fix.document, 'update_fea_constraint', { analysisId: fixture.analysisId, constraintId, name: 'renamed' }).summary,
    ).not.toContain('WARNING');
    const load = must(fixture.doc, 'add_fea_load', {
      analysisId: fixture.analysisId,
      name: 'p',
      kind: 'pressure',
      magnitude: 1000,
      target: near,
    });
    const loadId = load.affected[0] ?? '';
    expect(must(load.document, 'update_fea_load', { analysisId: fixture.analysisId, loadId, target: far }).summary).toContain('WARNING');
    expect(must(load.document, 'update_fea_load', { analysisId: fixture.analysisId, loadId, magnitude: 5 }).summary).not.toContain(
      'WARNING',
    );
  });

  it('update_thermal_bc warns for a far target', () => {
    const added = must(fixture.doc, 'add_thermal_bc', {
      analysisId: fixture.analysisId,
      name: 'f',
      kind: 'film',
      filmCoefficient: { value: 50, unit: 'W/(m^2*K)' },
      sinkTemperature: { value: 20, unit: 'degC' },
      source: { citation: 'test' },
      target: near,
    });
    const bcId = added.affected[0] ?? '';
    expect(must(added.document, 'update_thermal_bc', { analysisId: fixture.analysisId, bcId, target: far }).summary).toContain('WARNING');
    expect(must(added.document, 'update_thermal_bc', { analysisId: fixture.analysisId, bcId, target: near }).summary).not.toContain(
      'WARNING',
    );
  });
});
