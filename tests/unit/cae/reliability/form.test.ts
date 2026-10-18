import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { normalCdf } from '@cae/reliability/numerics';
import { code, data, lognormal, modelDoc, normal, relative, rMinusS, type Json } from './support';

const form = (doc: Parameters<typeof execute>[0], params: Json = {}): ReturnType<typeof execute> =>
  execute(doc, 'reliability_form', { limitState: 'g', ...params });

describe('reliability_form: linear limit state in normal variables (VC-PRB-01)', () => {
  it('matches beta = (muR - muS) / sqrt(sR^2 + sS^2) = 2, Pf = Φ(-2) and alpha^2 = [0.36, 0.64]', () => {
    const doc = rMinusS();
    const before = JSON.stringify(doc);
    const result = form(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const d = data(result);
    expect(relative(d['beta'] as number, 2)).toBeLessThan(1e-8);
    expect(relative(d['pfForm'] as number, 0.0227501319482)).toBeLessThan(1e-8);
    const importance = d['importance'] as Record<string, number>;
    expect(importance['R']).toBeCloseTo(0.36, 8);
    expect(importance['S']).toBeCloseTo(0.64, 8);
    const design = d['designPointX'] as Record<string, { value: number; unit: string }>;
    expect(design['R']?.value).toBeCloseTo(264, 5);
    expect(design['S']?.value).toBeCloseTo(264, 5);
    expect(design['R']?.unit).toBe('MPa');
    expect(d['converged']).toBe(true);
    expect(d['reviewRequired']).toBe(true);
    expect(d['originInFailureDomain']).toBe(false);
    expect(result.summary).toContain('beta = 2.000000');
  });

  it('reports PRB_TARGET_UNSET without a target, PRB_TARGET_NOT_MET when beta misses it, and nothing when met', () => {
    const codes = (limit: Json): string[] => ((data(form(rMinusS(limit)))['items'] as Array<{ code: string }>) ?? []).map((i) => i.code);
    expect(codes({})).toContain('PRB_TARGET_UNSET');
    expect(codes({ targetBeta: { value: 3, source: 'owner' } })).toContain('PRB_TARGET_NOT_MET');
    expect(codes({ targetPf: { value: 1e-3, source: 'owner' } })).toContain('PRB_TARGET_NOT_MET');
    expect(codes({ targetBeta: { value: 1.5, source: 'owner' } })).toEqual([]);
  });

  it('handles correlated normals through the Cholesky transform', () => {
    const doc = modelDoc([normal('R', 300, 30), normal('S', 200, 40)], 'R - S');
    const correlated = execute(doc, 'set_correlation', {
      names: ['R', 'S'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    }).document;
    const expected = 100 / Math.sqrt(30 ** 2 + 40 ** 2 - 2 * 0.5 * 30 * 40);
    expect(relative(data(form(correlated))['beta'] as number, expected)).toBeLessThan(1e-8);
  });

  it('flags unsourced scatter as unverified', () => {
    const doc = modelDoc([normal('R', 300, 30, false), normal('S', 200, 40)], 'R - S');
    const d = data(form(doc));
    expect(d['unverified']).toBe(true);
    expect((d['unverifiedReasons'] as string[])[0]).toContain('R');
    expect((d['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_SCATTER_UNSOURCED');
  });

  it('puts a limit state whose origin already fails at a negative beta', () => {
    const doc = modelDoc([normal('R', 100, 10), normal('S', 200, 10)], 'R - S');
    const d = data(form(doc));
    expect(d['originInFailureDomain']).toBe(true);
    expect(relative(d['beta'] as number, -100 / Math.sqrt(200))).toBeLessThan(1e-8);
    expect(d['pfForm'] as number).toBeGreaterThan(0.999);
  });
});

describe('reliability_form: non-normal marginals', () => {
  it('lognormal R and S: beta equals the exact value because the failure surface is linear in u (VC-PRB-02)', () => {
    const doc = modelDoc([lognormal('R', 300, 30), lognormal('S', 200, 40)], 'R - S');
    const zeta2 = (m: number, s: number): number => Math.log(1 + (s / m) ** 2);
    const lambda = (m: number, s: number): number => Math.log(m) - zeta2(m, s) / 2;
    const exact = (lambda(300, 30) - lambda(200, 40)) / Math.sqrt(zeta2(300, 30) + zeta2(200, 40));
    expect(relative(exact, 1.89451599469)).toBeLessThan(1e-9);
    const d = data(form(doc));
    expect(relative(d['beta'] as number, exact)).toBeLessThan(1e-6);
    expect(relative(d['pfForm'] as number, normalCdf(-exact))).toBeLessThan(1e-6);
    expect(d['converged']).toBe(true);
    expect(d['iterations'] as number).toBeLessThan(30);
  });

  it('OpenTURNS axial stressed beam: beta 1.88104651853 and the design point (VC-PRB-03)', () => {
    const doc = modelDoc([lognormal('R', 3e6, 3e5), normal('F', 750, 50)], 'R - F / (pi / 1e4)');
    const d = data(form(doc));
    expect(relative(d['beta'] as number, 1.88104651853)).toBeLessThan(1e-6);
    expect(relative(d['pfForm'] as number, 0.0299827955769)).toBeLessThan(1e-6);
    const design = d['designPointX'] as Record<string, { value: number }>;
    expect(relative(design['R']?.value ?? 0, 2546286.83181)).toBeLessThan(1e-5);
    expect(relative(design['F']?.value ?? 0, 799.939600476)).toBeLessThan(1e-5);
    expect(d['unit']).toBe('MPa');
  });

  it('correlated lognormals follow the Nataf closed form', () => {
    const doc = modelDoc([lognormal('R', 300, 30), lognormal('S', 200, 40)], 'R - S');
    const correlated = execute(doc, 'set_correlation', {
      names: ['R', 'S'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    }).document;
    const zetaR = Math.sqrt(Math.log(1 + 0.01));
    const zetaS = Math.sqrt(Math.log(1 + 0.04));
    const lambdaR = Math.log(300) - zetaR ** 2 / 2;
    const lambdaS = Math.log(200) - zetaS ** 2 / 2;
    const rho0 = Math.log(1 + 0.5 * 0.1 * 0.2) / (zetaR * zetaS);
    const exact = (lambdaR - lambdaS) / Math.sqrt(zetaR ** 2 + zetaS ** 2 - 2 * rho0 * zetaR * zetaS);
    expect(relative(data(form(correlated))['beta'] as number, exact)).toBeLessThan(1e-5);
  });

  it('uniform and Weibull marginals converge to a finite beta', () => {
    const doc = modelDoc(
      [
        { name: 'A', distribution: { kind: 'weibull', shape: 8, scale: 100 } },
        { name: 'B', distribution: { kind: 'uniform', min: 10, max: 50 } },
      ],
      'A - B',
    );
    const d = data(form(doc));
    expect(d['converged']).toBe(true);
    expect(d['beta'] as number).toBeGreaterThan(3);
  });
});

describe('reliability_form: SORM (VC-PRB-04)', () => {
  const quadratic = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '3 - u1 + 0.1 * pow(u2, 2)');

  it('gives beta 3, curvature 0.2 and the Breitung probability 1.06718809723e-3', () => {
    const d = data(form(quadratic, { sorm: true }));
    expect(relative(d['beta'] as number, 3)).toBeLessThan(1e-9);
    expect(relative(d['pfForm'] as number, 1.34989803163e-3)).toBeLessThan(1e-8);
    expect((d['curvatures'] as number[])[0]).toBeCloseTo(0.2, 6);
    expect(relative(d['pfSorm'] as number, 1.06718809723e-3)).toBeLessThan(1e-6);
    expect(d['method']).toBe('form+sorm');
    expect(data(form(quadratic))['pfSorm']).toBeUndefined();
  });

  it('is almost FORM for a linear limit state and warns when 1 + beta kappa <= 0', () => {
    const linear = data(form(rMinusS(), { sorm: true }));
    expect(relative(linear['pfSorm'] as number, linear['pfForm'] as number)).toBeLessThan(1e-6);
    const strong = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '3 - u1 - 0.5 * pow(u2, 2)');
    const d = data(form(strong, { sorm: true }));
    expect(d['pfSorm']).toBeNull();
    expect((d['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_SORM_INVALID');
  });

  it('refuses SORM when FORM has not converged', () => {
    const flat = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '1 - pow(u1, 2) - pow(u2, 2)');
    const d = data(form(flat, { sorm: true }));
    expect((d['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_SORM_INVALID');
  });
});

describe('reliability_form: failure paths', () => {
  it('returns the last iterate with PRB_FORM_NOT_CONVERGED when the gradient vanishes at the start (VC-PRB-13)', () => {
    const flat = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '1 - pow(u1, 2) - pow(u2, 2)');
    const result = form(flat);
    const d = data(result);
    expect(d['converged']).toBe(false);
    expect(d['designPointU']).toEqual([0, 0]);
    expect((d['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_FORM_NOT_CONVERGED');
    expect(result.summary).toContain('NOT converged');
  });

  it('stops without converging when the iteration budget is too small', () => {
    const doc = modelDoc([lognormal('R', 300, 30), lognormal('S', 200, 40)], 'R - S');
    expect(data(form(doc, { maxIterations: 1 }))['converged']).toBe(false);
  });

  it('refuses an unknown limit state, an empty model, an unknown symbol and unrealisable correlation', () => {
    const doc = rMinusS();
    const unknown = execute(doc, 'reliability_form', { limitState: 'nope' });
    expect(code(unknown)).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    expect(unknown.document).toBe(doc);
    expect(unknown.affected).toEqual([]);
    const noVariable = modelDoc([], '1 + 1');
    expect(code(form(noVariable))).toBe('PRB_MODEL_EMPTY');
    const missing = modelDoc([normal('R', 300, 30)], 'R');
    const model = JSON.parse(JSON.stringify(missing)) as { probabilistic: { variables: Record<string, unknown>; variableOrder: string[] } };
    model.probabilistic.variables = {};
    model.probabilistic.variableOrder = [];
    expect(code(form(model as unknown as typeof missing))).toBe('PRB_EXPRESSION_INVALID');
    const hard = modelDoc([lognormal('R', 1, 1), normal('S', 0, 1)], 'R - S');
    const broken = JSON.parse(JSON.stringify(hard)) as { probabilistic: { correlation?: unknown } };
    broken.probabilistic.correlation = {
      names: ['R', 'S'],
      matrix: [
        [1, 0.99],
        [0.99, 1],
      ],
    };
    expect(code(form(broken as unknown as typeof hard))).toBe('PRB_CORRELATION_INVALID');
  });

  it('rejects invalid params through the schema', () => {
    const doc = rMinusS();
    expect(execute(doc, 'reliability_form', {}).document).toBe(doc);
    expect(execute(doc, 'reliability_form', { limitState: 'g', maxIterations: 0 }).summary).toMatch(/rejected/);
  });
});
