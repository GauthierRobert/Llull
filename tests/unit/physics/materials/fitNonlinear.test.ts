/** M7: Levenberg-Marquardt fits — recovered-parameter fixtures (VC-MATL-19…23), Treloar Ogden / Arruda-Boyce, refusals and the convergence report. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { nominalStress, arrudaBoyceDerivatives, type ResolvedHyper } from '@core/model/materialLaws/hyperelastic';
import { levenbergMarquardt } from '@core/model/materialLaws/levenbergMarquardt';
import { symmetricEigen } from '@core/model/materialLaws/eigen';
import { PACK, codeOf, run } from './materialFixtures';

type Rows = number[][];
const TRELOAR: Record<'UT' | 'ET' | 'PS', Rows> = { UT: [], ET: [], PS: [] };
for (const line of readFileSync(`docs/physics/${PACK}/validation/treloar_1944_steinmann2012.csv`, 'utf8').split('\n')) {
  if (line.startsWith('#') || line.startsWith('mode') || line.trim() === '') continue;
  const [mode, stretch, stress] = line.split(',');
  TRELOAR[mode as 'UT' | 'ET' | 'PS'].push([Number(stretch), Number(stress)]);
}
const MODE = { UT: 'uniaxial', ET: 'equibiaxial', PS: 'planar' } as const;
const treloar = (mode: 'UT' | 'ET' | 'PS'): Record<string, unknown> => ({
  mode: MODE[mode],
  rows: TRELOAR[mode],
  xMeasure: 'stretch',
  yMeasure: 'nominal_stress',
  units: { y: 'MPa' },
});
const ALL = [treloar('UT'), treloar('ET'), treloar('PS')];
const doc = createEmptyDocument();

interface FitData {
  model: Record<string, unknown>;
  fit: { method: string; tool: string; residual: { rms: number; unit: string }; conditionNumber: number };
  residualsPerTest: { mode: string; rms: number }[];
  stability: { drucker?: Record<string, { tension: number | null; compression: number | null }>; shearModulus?: number };
  convergence: {
    converged: boolean;
    stop: string;
    iterations: number;
    evaluations: number;
    cost: number;
    conditionNumber: number;
    starts: { tried: number; converged: number; best: number; source: string };
    parameters: { name: string; value: number; atBound: boolean }[];
  };
  defaults: { name: string }[];
  warnings: { code: string }[];
  validity: unknown[];
}
const fit = (params: Record<string, unknown>): FitData => run(doc, 'fit_material_model', params).data as FitData;
const refusal = (params: Record<string, unknown>): string => codeOf(doc, 'fit_material_model', params);

/** Synthetic noise-free rows of a resolved law in the three modes. */
const synthetic = (law: ResolvedHyper, stretches: readonly number[], modes: readonly ('UT' | 'ET' | 'PS')[]): Record<string, unknown>[] =>
  modes.map((mode) => ({
    mode: MODE[mode],
    rows: stretches.map((lambda) => [lambda, nominalStress(law, mode, lambda)]),
    xMeasure: 'stretch',
    yMeasure: 'nominal_stress',
    units: { y: 'MPa' },
  }));

const STRETCHES = [1.05, 1.1, 1.2, 1.35, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5];

describe('Levenberg-Marquardt core', () => {
  it('finds the minimum of a bounded Rosenbrock-type residual and reports its conditioning', () => {
    const result = levenbergMarquardt((p) => [10 * ((p[1] ?? 0) - (p[0] ?? 0) ** 2), 1 - (p[0] ?? 0)], [-1.2, 1], {
      lower: [-5, -5],
      upper: [5, 5],
    });
    expect(result.converged).toBe(true);
    expect(result.params[0]).toBeCloseTo(1, 8);
    expect(result.params[1]).toBeCloseTo(1, 8);
    expect(Number.isFinite(result.conditionNumber)).toBe(true);
    expect(result.iterations).toBeLessThan(100);
  });

  it('honours bounds: the constrained minimum sits on the bound', () => {
    const result = levenbergMarquardt((p) => [(p[0] ?? 0) - 3, (p[1] ?? 0) + 1], [0, 0], { lower: [-10, 0], upper: [2, 10] });
    expect(result.params[0]).toBeCloseTo(2, 10);
    expect(result.params[1]).toBeCloseTo(0, 10);
    expect(result.converged).toBe(true);
  });

  it('flags an invalid start and a non-converging run', () => {
    expect(levenbergMarquardt(() => null, [1], { lower: [0], upper: [2] }).stop).toBe('invalid_start');
    const slow = levenbergMarquardt((p) => [Math.sin((p[0] ?? 0) * 100) + (p[0] ?? 0) * 0.001], [0.3], {
      lower: [-1e6],
      upper: [1e6],
      maxIterations: 1,
    });
    expect(slow.converged).toBe(false);
    expect(slow.stop).toBe('max_iterations');
  });

  it('computes symmetric eigenpairs', () => {
    const { values, vectors } = symmetricEigen([
      [2, 1, 0],
      [1, 2, 0],
      [0, 0, 5],
    ]);
    expect(values[0]).toBeCloseTo(1, 12);
    expect(values[1]).toBeCloseTo(3, 12);
    expect(values[2]).toBeCloseTo(5, 12);
    expect(Math.abs(vectors[2]?.[2] ?? 0)).toBeCloseTo(1, 12);
  });
});

describe('Ogden fits (VC-MATL-19)', () => {
  const truth: ResolvedHyper = { kind: 'ogden', mu: [0.4, 0.002], alpha: [2, 6], shearModulus: 0.402 };
  it('recovers a two-term Ogden set from noise-free data in the three modes', () => {
    const data = fit({ kind: 'hyper_ogden', terms: 2, tests: synthetic(truth, STRETCHES, ['UT', 'ET', 'PS']) });
    const terms = (data.model['terms'] as { mu: number; alpha: number }[]).slice().sort((a, b) => a.alpha - b.alpha);
    expect(terms[0]?.alpha).toBeCloseTo(2, 4);
    expect(terms[1]?.alpha).toBeCloseTo(6, 3);
    expect(terms[0]?.mu).toBeCloseTo(0.4, 5);
    expect(terms[1]?.mu).toBeCloseTo(0.002, 6);
    expect(data.model['convention']).toBe('calculix');
    expect(data.fit.method).toBe('levenberg_marquardt');
    expect(data.convergence.converged).toBe(true);
    expect(data.convergence.starts.source).toBe('grid');
    expect(data.convergence.starts.tried).toBe(10);
    expect(data.fit.residual.rms).toBeLessThan(1e-7);
    expect(data.stability.shearModulus).toBeCloseTo(0.402, 5);
    expect(data.defaults.map((d) => d.name)).toContain('positive');
  });

  it('is deterministic and its model is accepted unchanged by add_material_model', () => {
    const params = {
      kind: 'hyper_ogden',
      terms: 1,
      tests: synthetic({ kind: 'ogden', mu: [0.5], alpha: [3], shearModulus: 0.5 }, STRETCHES, ['UT', 'PS']),
    };
    const a = fit(params);
    expect(JSON.stringify(fit(params).model)).toBe(JSON.stringify(a.model));
    const withMaterial = execute(doc, 'create_material', {
      name: 'rubber',
      density: 0.001,
      color: '#222222',
      metalness: 0,
      roughness: 0.9,
    }).document;
    const added = execute(withMaterial, 'add_material_model', {
      material: 'rubber',
      id: 'ogden.fit',
      model: a.model,
      validity: a.validity,
      basis: 'unspecified',
      source: { citation: 'synthetic' },
      fit: a.fit,
    });
    expect(added.error).toBeUndefined();
  });

  it('fits Treloar (all modes, 3 terms) at least as well in uniaxial tension as the cited Ogden 1972 set (OQ-MATL-03)', () => {
    const data = fit({ kind: 'hyper_ogden', terms: 3, tests: ALL });
    expect(data.convergence.converged).toBe(true);
    const ut = data.residualsPerTest.find((r) => r.mode === 'UT');
    expect(ut?.rms).toBeLessThan(0.2879);
    expect(data.fit.residual.rms).toBeLessThan(0.2);
    expect(data.stability.drucker).toBeDefined();
    expect(data.fit.conditionNumber).toBeLessThan(1e12);
  });

  it('start replaces the multi-start; a start outside the bounds or with a wrong name is refused', () => {
    const tests = synthetic(truth, STRETCHES, ['UT', 'ET', 'PS']);
    const started = fit({ kind: 'hyper_ogden', terms: 2, tests, start: { mu1: 0.3, mu2: 0.003, alpha1: 1.5, alpha2: 5 } });
    expect(started.convergence.starts).toMatchObject({ tried: 1, source: 'user' });
    expect(refusal({ kind: 'hyper_ogden', terms: 2, tests, start: { mu1: 0.3, mu2: 0.003, alpha1: 1.5 } })).toBe('MATL_FIT_START_INVALID');
    expect(refusal({ kind: 'hyper_ogden', terms: 2, tests, start: { mu1: -1, mu2: 0.003, alpha1: 1.5, alpha2: 5 } })).toBe(
      'MATL_FIT_START_INVALID',
    );
    expect(refusal({ kind: 'hyper_ogden', terms: 2, tests, bounds: { nope: [0, 1] } })).toBe('MATL_FIT_START_INVALID');
    expect(refusal({ kind: 'hyper_ogden', terms: 2, tests, bounds: { alpha1: [5, 1] } })).toBe('MATL_FIT_START_INVALID');
  });

  it('bounds that exclude the solution put the parameter on the bound and warn', () => {
    const data = fit({
      kind: 'hyper_ogden',
      terms: 1,
      tests: synthetic({ kind: 'ogden', mu: [0.5], alpha: [3], shearModulus: 0.5 }, STRETCHES, ['UT', 'ET']),
      bounds: { alpha1: [null, 2] },
    });
    expect(data.convergence.parameters.find((p) => p.name === 'alpha1')?.atBound).toBe(true);
    expect(data.warnings.map((w) => w.code)).toContain('MATL_FIT_PARAMETER_AT_BOUND');
  });

  it('refuses missing terms, too few rows, and an under-determined data set', () => {
    expect(refusal({ kind: 'hyper_ogden', tests: ALL })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'hyper_ogden', terms: 4, tests: ALL })).toBe('MATL_LAW_PARAMS_INVALID');
    const few = [
      {
        mode: 'uniaxial',
        rows: [
          [1.5, 0.3],
          [2, 0.5],
          [3, 0.9],
        ],
        xMeasure: 'stretch',
        yMeasure: 'nominal_stress',
        units: { y: 'MPa' },
      },
    ];
    expect(refusal({ kind: 'hyper_ogden', terms: 2, tests: few })).toBe('MATL_FIT_INSUFFICIENT_DATA');
  });

  it('refuses an ill-conditioned three-term fit of a single smooth curve', () => {
    const one = synthetic({ kind: 'ogden', mu: [0.5], alpha: [2], shearModulus: 0.5 }, [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8], ['UT']);
    expect(refusal({ kind: 'hyper_ogden', terms: 3, tests: one })).toMatch(/MATL_FIT_(ILL_CONDITIONED|DID_NOT_CONVERGE)/);
  });
});

describe('Arruda-Boyce fit (VC-MATL-20)', () => {
  it('recovers μ and λm from noise-free three-mode data', () => {
    const truth: ResolvedHyper = { kind: 'invariant', derivatives: arrudaBoyceDerivatives(0.27, 2.8), shearModulus: 0.27 };
    const data = fit({ kind: 'hyper_arruda_boyce', tests: synthetic(truth, [1.1, 1.3, 1.6, 1.9, 2.2, 2.5], ['UT', 'ET', 'PS']) });
    expect((data.model['mu'] as { value: number }).value).toBeCloseTo(0.27, 5);
    expect(data.model['lambdaM']).toBeCloseTo(2.8, 4);
    expect(data.convergence.converged).toBe(true);
  });

  it('fits Treloar with a physically meaningful locking stretch and reports stability', () => {
    const data = fit({ kind: 'hyper_arruda_boyce', tests: ALL });
    expect(data.convergence.converged).toBe(true);
    expect(data.model['lambdaM']).toBeGreaterThan(3);
    expect(data.fit.residual.rms).toBeLessThan(0.6);
    expect(data.stability.drucker).toBeDefined();
  });
});

describe('Prony with free relaxation times (VC-MATL-21)', () => {
  const g = [0.3, 0.2];
  const tau = [0.1, 10];
  const times = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300];
  const rows = [[0, 100], ...times.map((t) => [t, 100 * (1 - g.reduce((s, gi, i) => s + gi * (1 - Math.exp(-t / (tau[i] ?? 1))), 0))])];
  const test = { mode: 'relaxation', rows, xMeasure: 'time', yMeasure: 'shear_modulus', units: { x: 's', y: 'MPa' } };

  it('recovers g_i and τ_i of a two-term series', () => {
    const data = fit({ kind: 'visco_prony', terms: 2, tests: [test] });
    const shear = data.model['shear'] as { g: number; tau: { value: number } }[];
    expect(shear[0]?.g).toBeCloseTo(0.3, 5);
    expect(shear[0]?.tau.value).toBeCloseTo(0.1, 5);
    expect(shear[1]?.g).toBeCloseTo(0.2, 5);
    expect(shear[1]?.tau.value).toBeCloseTo(10, 4);
    expect(data.convergence.converged).toBe(true);
    expect(data.fit.residual.unit).toBe('1');
  });

  it('refuses wrong inputs and a missing term count', () => {
    expect(refusal({ kind: 'visco_prony', tests: [test] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'visco_prony', terms: 2, tests: [{ ...test, mode: 'x' }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'visco_prony', terms: 2, tests: [{ ...test, units: { x: 's' } }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'visco_prony', terms: 2, tests: [{ ...test, rows: rows.slice(1) }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'visco_prony', terms: 5, tests: [{ ...test, rows: rows.slice(0, 6) }] })).toBe('MATL_FIT_INSUFFICIENT_DATA');
  });
});

describe('Ramberg-Osgood true-stress form (VC-MATL-22)', () => {
  const E = 72000;
  const sigma0 = 400;
  const alpha = 0.36;
  const n = 15;
  const stresses = [100, 200, 300, 350, 400, 420, 440, 460];
  const strain = (s: number): number => s / E + (alpha / E) * (s / sigma0) ** (n - 1) * s;
  const test = {
    mode: 'uniaxial_plastic',
    rows: stresses.map((s) => [strain(s), s]),
    xMeasure: 'total_strain',
    yMeasure: 'true_stress',
    units: { y: 'MPa' },
  };
  const fixed = { E: { value: 72, unit: 'GPa' }, nu: { value: 0.33, unit: '1' }, sigma0: { value: sigma0, unit: 'MPa' } };

  it('recovers α and n and the model is a calculix-form Ramberg-Osgood law', () => {
    const data = fit({ kind: 'ramberg_osgood', form: 'true_stress', tests: [test], fixed });
    expect(data.model['n']).toBeCloseTo(15, 4);
    expect(data.model['alpha']).toBeCloseTo(0.36, 5);
    expect(data.model['form']).toBe('calculix');
    expect(data.fit.method).toBe('levenberg_marquardt');
    const material = execute(doc, 'create_material', {
      name: 'al',
      density: 0.0028,
      color: '#cccccc',
      metalness: 1,
      roughness: 0.3,
    }).document;
    const added = execute(material, 'add_material_model', {
      material: 'al',
      id: 'ro',
      model: data.model,
      validity: data.validity,
      basis: 'unspecified',
      source: { citation: 'synthetic' },
    });
    expect(added.error).toBeUndefined();
  });

  it('refuses without sigma0, E or nu and for the wrong test mode', () => {
    const noSigma = { E: fixed.E, nu: fixed.nu };
    expect(refusal({ kind: 'ramberg_osgood', form: 'true_stress', tests: [test], fixed: noSigma })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'ramberg_osgood', form: 'true_stress', tests: [test], fixed: { ...fixed, E: 1 } })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(refusal({ kind: 'ramberg_osgood', form: 'true_stress', tests: [test], fixed: { E: fixed.E, sigma0: fixed.sigma0 } })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(refusal({ kind: 'ramberg_osgood', form: 'true_stress', tests: [{ ...test, mode: 'x' }], fixed })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(refusal({ kind: 'ramberg_osgood', form: 'true_stress', tests: [{ ...test, rows: test.rows.slice(0, 2) }], fixed })).toBe(
      'MATL_FIT_INSUFFICIENT_DATA',
    );
  });
});

describe('Voce, Chaboche and Garofalo fits (VC-MATL-23)', () => {
  const plastic = (law: (e: number) => number, strains: number[]): Record<string, unknown> => ({
    mode: 'uniaxial_plastic',
    rows: strains.map((e) => [e, law(e)]),
    xMeasure: 'plastic_strain',
    yMeasure: 'true_stress',
    units: { y: 'MPa' },
  });
  const strains = [0.0005, 0.001, 0.002, 0.004, 0.008, 0.015, 0.03, 0.06, 0.1];

  it('recovers Voce σy, Q, b', () => {
    const data = fit({ kind: 'j2_voce', tests: [plastic((e) => 250 + 150 * (1 - Math.exp(-40 * e)), strains)] });
    const isotropic = data.model['isotropic'] as { yieldStress: { value: number }; Q: { value: number }; b: number };
    expect(isotropic.yieldStress.value).toBeCloseTo(250, 3);
    expect(isotropic.Q.value).toBeCloseTo(150, 3);
    expect(isotropic.b).toBeCloseTo(40, 3);
  });

  it('recovers a two-term monotonic Chaboche with fixed yield and warns that cyclic response is unidentified', () => {
    const law = (e: number): number => 200 + (20000 / 100) * (1 - Math.exp(-100 * e)) + (2000 / 5) * (1 - Math.exp(-5 * e));
    const data = fit({
      kind: 'j2_chaboche',
      terms: 2,
      fixed: { yieldStress: { value: 200, unit: 'MPa' } },
      tests: [plastic(law, [0.0002, 0.0005, 0.001, 0.002, 0.004, 0.008, 0.015, 0.03, 0.06, 0.1, 0.2])],
    });
    const back = (data.model['kinematic'] as { backstresses: { C: { value: number }; gamma: number }[] }).backstresses;
    expect(back[0]?.gamma).toBeCloseTo(5, 2);
    expect(back[1]?.gamma).toBeCloseTo(100, 1);
    expect(back[0]?.C.value).toBeCloseTo(2000, 0);
    expect(back[1]?.C.value).toBeCloseTo(20000, -1);
    expect(data.warnings.map((w) => w.code)).toContain('MATL_FIT_MONOTONIC_ONLY');
  });

  it('refuses Chaboche without terms or yieldStress', () => {
    const t = plastic((e) => 200 + 100 * e, strains);
    expect(refusal({ kind: 'j2_chaboche', tests: [t], fixed: { yieldStress: { value: 200, unit: 'MPa' } } })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(refusal({ kind: 'j2_chaboche', terms: 1, tests: [t] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'j2_voce', tests: [{ ...t, rows: [[0.001, 300]] }] })).toBe('MATL_FIT_INSUFFICIENT_DATA');
  });

  it('recovers Garofalo A, α, n and the activation energy from several temperatures', () => {
    const A = 2e-4;
    const alpha = 0.02;
    const n = 4.5;
    const Q = 250000;
    const rate = (s: number, T: number): number => A * Math.sinh(alpha * s) ** n * Math.exp(-Q / (8.314462618 * T));
    const rows: number[][] = [];
    for (const T of [800, 850, 900, 950]) for (const s of [40, 60, 80, 100, 140]) rows.push([s, T, rate(s, T)]);
    const test = { mode: 'creep_rate', rows, xMeasure: 'stress', yMeasure: 'creep_rate', units: { x: 'MPa', T: 'K', y: '1/s' } };
    const data = fit({ kind: 'creep_garofalo', tests: [test] });
    expect(data.model['n']).toBeCloseTo(4.5, 3);
    expect((data.model['alpha'] as { value: number }).value).toBeCloseTo(0.02, 5);
    expect((data.model['activationEnergy'] as { value: number }).value).toBeCloseTo(250000, -1);
    const fixedQ = fit({ kind: 'creep_garofalo', tests: [test], fixed: { activationEnergy: { value: 250, unit: 'kJ/mol' } } });
    expect(fixedQ.convergence.parameters.map((p) => p.name)).toEqual(['A', 'alpha', 'n']);
    expect(refusal({ kind: 'creep_garofalo', tests: [{ ...test, units: { x: 'MPa' } }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'creep_garofalo', tests: [{ ...test, rows: [[1, 2]] }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(refusal({ kind: 'creep_garofalo', tests: [{ ...test, rows: rows.slice(0, 3) }] })).toBe('MATL_FIT_INSUFFICIENT_DATA');
    expect(refusal({ kind: 'creep_garofalo', fixed: { activationEnergy: { value: 1, unit: 'MPa' } }, tests: [test] })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
  });

  it('flags a free activation energy fitted from one temperature: Q is not identified and ends on its bound', () => {
    const rows = [40, 60, 80, 100, 140, 160].map((s) => [s, 900, 2e-4 * Math.sinh(0.02 * s) ** 4.5 * Math.exp(-250000 / (8.314462618 * 900))]);
    const test = { mode: 'creep_rate', rows, xMeasure: 'stress', yMeasure: 'creep_rate', units: { x: 'MPa', T: 'K', y: '1/s' } };
    const data = fit({ kind: 'creep_garofalo', tests: [test] });
    expect(data.convergence.parameters.find((p) => p.name === 'activationEnergy')?.atBound).toBe(true);
    expect(data.warnings.map((w) => w.code)).toContain('MATL_FIT_PARAMETER_AT_BOUND');
  });
});
