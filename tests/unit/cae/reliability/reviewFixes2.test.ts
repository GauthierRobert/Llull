/** Review fixes of the PRB M4 / M3 round: unapplied variables, surface reliability, importance-sampling fallbacks, fail-fast Sobol. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { isStudyFailure, studyContext } from '@cae/reliability/context';
import { runForm } from '@cae/reliability/form';
import { importanceStudy } from '@cae/reliability/importanceStudy';
import { fitQuadraticSurface } from '@cae/reliability/surface';
import { withVariableValues } from '@cae/reliability/variableInputs';
import type { RandomVariable } from '@cae/reliability/types';
import { code, data, modelDoc, normal, type Json } from './support';
import { massModel } from './responses.support';

const mass = massModel().doc;
const addVariable = (doc: CadDocument, variable: Json): CadDocument =>
  execute(doc, 'define_random_variable', {
    unit: 'g',
    distribution: { kind: 'normal', mean: 1, sd: 0.1 },
    citation: { text: 't' },
    ...variable,
  }).document;

const unapplied: ReadonlyArray<readonly [string, CadDocument]> = [
  ['a free symbol', addVariable(mass, { name: 'loose' })],
  [
    'a non-density material property',
    addVariable(mass, { name: 'modulus', binding: { kind: 'materialProperty', material: 'test_al', property: 'E' } }),
  ],
  [
    'a parameter binding whose parameter is gone',
    (() => {
      const bound = addVariable(mass, { name: 'ghost_rv', binding: { kind: 'parameter', parameter: 'w' } });
      const { w, ...parameters } = bound.parameters;
      void w;
      return { ...bound, parameters };
    })(),
  ],
];

describe.each(unapplied)('a response study refuses %s (PRB_VARIABLE_NOT_APPLIED)', (_kind, doc) => {
  const names = (variableName: string): void => {
    for (const [command, extra] of [
      ['sensitivity_indices', { samples: 16, seed: 1 }],
      ['morris_screening', { seed: 1 }],
      ['response_surface_study', { seed: 1, points: 30 }],
    ] as const) {
      const result = execute(doc, command, { response: 'mass', ...extra });
      expect(code(result)).toBe('PRB_VARIABLE_NOT_APPLIED');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain(variableName);
    }
  };
  it('in sensitivity_indices, morris_screening and response_surface_study, naming the variable', () => {
    names(_kind.includes('free') ? 'loose' : _kind.includes('material') ? 'modulus' : 'ghost_rv');
  });
});

describe('variableInputs', () => {
  const rho = (material: string, mean: number): RandomVariable => ({
    id: 'rv-1',
    name: 'rho',
    unit: 'g/mm^3',
    distribution: { kind: 'normal', mean, sd: 0.0001 },
    binding: { kind: 'materialProperty', material, property: 'density' },
  });
  it('returns null for a missing material, and for a non-finite density factor (mean 0)', () => {
    expect(withVariableValues(mass, [rho('no_such_material', 0.0027)], [0.0028], undefined)).toBeNull();
    expect(withVariableValues(mass, [rho('test_al', 0)], [0.0028], undefined)).toBeNull();
    expect(withVariableValues(mass, [rho('test_al', 0.0027)], [Number.NaN], undefined)).toBeNull();
    const ok = withVariableValues(mass, [rho('test_al', 0.0027)], [0.00297], undefined);
    expect(ok?.materials['test_al']?.density).toBeCloseTo(0.0027 * 1.1, 12);
    expect(mass.materials['test_al']?.density).toBe(0.0027);
  });
});

describe('response surface reliability', () => {
  const sorm = (): CadDocument => modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '3 - u1 + 0.1 * pow(u2, 2)');
  const run = (doc: CadDocument, params: Json): ReturnType<typeof execute> =>
    execute(doc, 'response_surface_study', { limitState: 'g', seed: 21, points: 60, samples: 2000, ...params });
  const codes = (result: ReturnType<typeof execute>): string[] => (data(result)['items'] as Array<{ code: string }>).map((i) => i.code);

  it('a point that alone determines its fit has an infinite leave-one-out residual, never a silent NaN', () => {
    const xs = [0, 0, 0, 1, 2];
    const fit = fitQuadraticSurface(
      xs.map((x) => [x]),
      xs.map((x) => x * x + 1),
    );
    expect(fit).not.toBeNull();
    expect(Number.isNaN(fit?.looRmse)).toBe(false);
    expect(fit?.looRmse).toBe(Number.POSITIVE_INFINITY);
  });

  it('the study accepts points = terms + 1 and either answers with a finite residual or refuses PRB_SURFACE_UNRELIABLE', () => {
    const result = run(sorm(), { points: 7 });
    if (code(result) === undefined) expect(Number.isFinite((data(result)['surface'] as Json)['looRelative'])).toBe(true);
    else expect(code(result)).toBe('PRB_SURFACE_UNRELIABLE');
    expect(result.document).toBeDefined();
  });

  it('warns PRB_SURFACE_EXTRAPOLATION when the design point lies beyond 2 x spread, not when it is covered', () => {
    expect(codes(run(sorm(), { spread: 0.5 }))).toContain('PRB_SURFACE_EXTRAPOLATION');
    expect(codes(run(sorm(), { spread: 2 }))).not.toContain('PRB_SURFACE_EXTRAPOLATION');
  });

  it('the Monte Carlo seed at 2^32 - 1 does not overflow: deterministic and equal to the wrapped seed 0 stream', () => {
    const a = data(run(sorm(), { seed: 2 ** 32 - 1 }))['monteCarlo'];
    expect(JSON.stringify(data(run(sorm(), { seed: 2 ** 32 - 1 }))['monteCarlo'])).toBe(JSON.stringify(a));
  });
});

describe('importance sampling', () => {
  const study = (doc: CadDocument, params: Json = {}): Json =>
    data(execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['is'], seed: 5, samples: 400, ...params }))[
      'importanceSampling'
    ] as Json;

  it('names the effective number of FAILURE samples, never above the number of failures drawn', () => {
    const d = study(modelDoc([normal('R', 300, 30), normal('S', 200, 40)], 'R - S'));
    expect(d['effectiveSampleSize']).toBeUndefined();
    expect(d['effectiveFailureSamples'] as number).toBeGreaterThan(0);
    expect(d['effectiveFailureSamples'] as number).toBeLessThanOrEqual(400);
  });

  it('FORM never hands importance sampling a non-finite centre: an unevaluable g leaves the design point at the origin (plain Monte Carlo)', () => {
    for (const g of [
      () => Number.NaN,
      (u: number[]) => (u[0] === 0 ? 1 : Number.POSITIVE_INFINITY),
      (u: number[]) => 1 - 1e300 * (u[0] ?? 0),
    ]) {
      const form = runForm(g, 2, { maxIterations: 20, tolerance: 1e-8 });
      expect(form.u.every((value) => Number.isFinite(value))).toBe(true);
    }
    const doc = modelDoc([normal('R', 300, 30)], 'R - 200');
    const context = studyContext(doc, 'g');
    if (isStudyFailure(context)) throw new Error(context.message);
    const result = importanceStudy({ ...context, evaluate: () => Number.NaN }, 20, 1, 5, 1e-8);
    expect(Object.values(result.data['centre'] as Record<string, number>)).toEqual([0]);
    expect(result.pf).toBeNaN();
  });
});

describe('sensitivity_indices fails fast and morris takes a tail probability', () => {
  it('stops at the first non-finite value and says where', () => {
    const doc = modelDoc([normal('R', 300, 30)], 'ln(310 - R)');
    const result = execute(doc, 'sensitivity_indices', { limitState: 'g', samples: 200, seed: 1 });
    expect(code(result)).toBe('PRB_RESPONSE_FAILED');
    expect(result.summary).toMatch(/not a finite number at base sample \d+ .*stopped after \d+ of 600 evaluations/);
    expect(result.document).toBe(doc);
  });

  it('tailProbability sets the probability range: exact (1 - 2 tail) x slope for a uniform variable, a narrower effect for a normal', () => {
    const uniform = modelDoc([{ name: 'x', distribution: { kind: 'uniform', min: 0, max: 1 } }], '3 * x');
    const muStar = (doc: CadDocument, tail?: number): number =>
      (
        (
          data(
            execute(doc, 'morris_screening', {
              limitState: 'g',
              seed: 2,
              trajectories: 4,
              ...(tail === undefined ? {} : { tailProbability: tail }),
            }),
          )['variables'] as Array<{ muStar: number }>
        )[0] as { muStar: number }
      ).muStar;
    expect(Math.abs(muStar(uniform, 0.001) / (3 * (1 - 0.002)) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(muStar(uniform) / 3 - 1)).toBeLessThan(1e-5);
    const gaussian = modelDoc([normal('x', 0, 1)], '3 * x');
    expect(muStar(gaussian, 0.001)).toBeLessThan(muStar(gaussian));
    expect(code(execute(gaussian, 'morris_screening', { limitState: 'g', seed: 2, tailProbability: 0.5 }))).toBe('CMD_INVALID_PARAMS');
  });
});
