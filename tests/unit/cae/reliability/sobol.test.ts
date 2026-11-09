import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { sobolIndices } from '@cae/reliability/sobol';
import { code, data, modelDoc, normal, type Json } from './support';

/** Ishigami closed form (a = 7, b = 0.1, X ~ U(-pi, pi)): Ishigami & Homma 1990; validation/expected_results.json VC-PRB-05. */
const A = 7;
const B = 0.1;
const V1 = 0.5 * (1 + (B * Math.PI ** 4) / 5) ** 2;
const V2 = (A * A) / 8;
const V13 = (B * B * Math.PI ** 8 * 8) / 225;
const VAR = V2 + (B * Math.PI ** 4) / 5 + (B * B * Math.PI ** 8) / 18 + 0.5;
const ISHIGAMI = { S: [V1 / VAR, V2 / VAR, 0], ST: [(V1 + V13) / VAR, V2 / VAR, V13 / VAR] };

const uniform = (name: string): { name: string; distribution: Json } => ({
  name,
  distribution: { kind: 'uniform', min: -Math.PI, max: Math.PI },
});
const ishigamiDoc = (): ReturnType<typeof modelDoc> =>
  modelDoc([uniform('x1'), uniform('x2'), uniform('x3')], 'sin(x1) + 7 * pow(sin(x2), 2) + 0.1 * pow(x3, 4) * sin(x1)', {});
type Table = Record<string, { value: number; ci95: [number, number] | null }>;
const indices = (params: Json, doc = ishigamiDoc()): ReturnType<typeof execute> =>
  execute(doc, 'sensitivity_indices', { limitState: 'g', samples: 8192, seed: 12345, ...params });

describe('sobolIndices estimator', () => {
  it('recovers the closed forms of an additive model Y = X1 + 2 X2 (S = ST = 1/5, 4/5)', () => {
    const n = 4096;
    const a = Array.from({ length: n }, (_, k) => [Math.sin(k * 12.9898) * 5, Math.cos(k * 78.233) * 5]);
    const b = Array.from({ length: n }, (_, k) => [Math.sin(k * 3.1 + 1) * 5, Math.cos(k * 1.7 + 2) * 5]);
    const f = (x: number[]): number => (x[0] ?? 0) + 2 * (x[1] ?? 0);
    const result = sobolIndices(
      Float64Array.from(a.map(f)),
      Float64Array.from(b.map(f)),
      [0, 1].map((i) => Float64Array.from(a.map((row, k) => f(row.map((v, j) => (j === i ? (b[k]?.[j] ?? 0) : v)))))),
      0,
    );
    expect(result.first[0]?.value).toBeCloseTo(0.2, 1);
    expect(result.first[1]?.value).toBeCloseTo(0.8, 1);
    expect(result.total[1]?.value).toBeCloseTo(result.first[1]?.value ?? 0, 1);
    expect(result.first[0]?.ci95).toBeNull();
  });
});

describe('sensitivity_indices', () => {
  it('matches the Ishigami closed form within 0.03 at N = 8192 (VC-PRB-05) with bootstrap intervals', () => {
    const doc = ishigamiDoc();
    const before = JSON.stringify(doc);
    const result = indices({}, doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const d = data(result);
    const S = d['S'] as Table;
    const ST = d['ST'] as Table;
    ['x1', 'x2', 'x3'].forEach((name, i) => {
      expect(Math.abs((S[name]?.value ?? 9) - (ISHIGAMI.S[i] ?? 0))).toBeLessThan(0.03);
      expect(Math.abs((ST[name]?.value ?? 9) - (ISHIGAMI.ST[i] ?? 0))).toBeLessThan(0.03);
      const [low, high] = S[name]?.ci95 ?? [1, 0];
      expect(low).toBeLessThanOrEqual(S[name]?.value ?? 0);
      expect(high).toBeGreaterThanOrEqual(S[name]?.value ?? 0);
    });
    expect(Math.abs((d['variance'] as number) - VAR)).toBeLessThan(0.5);
    expect(Math.abs((d['mean'] as number) - 3.5)).toBeLessThan(0.15);
    expect(d['evaluations']).toBe(8192 * 5);
    expect(d['reviewRequired']).toBe(true);
    expect(d['bootstrap']).toBe(200);
    expect(result.summary).toContain('x1 S');
  });

  it('is deterministic for (samples, seed) and changes with the seed; lhs sampling and bootstrap 0 are accepted', () => {
    const doc = ishigamiDoc();
    const first = indices({ samples: 512 }, doc);
    expect(JSON.stringify(data(indices({ samples: 512 }, doc)))).toBe(JSON.stringify(data(first)));
    expect(JSON.stringify(data(indices({ samples: 512, seed: 99 }, doc)))).not.toBe(JSON.stringify(data(first)));
    const lhs = data(indices({ samples: 1024, sampling: 'lhs', bootstrap: 0 }, doc));
    expect((lhs['S'] as Table)['x2']?.ci95).toBeNull();
    expect(Math.abs(((lhs['S'] as Table)['x2']?.value ?? 9) - V2 / VAR)).toBeLessThan(0.1);
  });

  it('gives S = ST = variance share for an additive linear model of independent normals (R - 2 S)', () => {
    const doc = modelDoc([normal('R', 300, 30), normal('S', 200, 40)], 'R - 2 * S');
    const d = data(indices({ samples: 4096, seed: 3 }, doc));
    const expected = [900 / (900 + 6400), 6400 / (900 + 6400)];
    expect(Math.abs(((d['S'] as Table)['R']?.value ?? 9) - (expected[0] ?? 0))).toBeLessThan(0.03);
    expect(Math.abs(((d['ST'] as Table)['S']?.value ?? 9) - (expected[1] ?? 0))).toBeLessThan(0.03);
    expect(d['unit']).toBe('MPa');
    expect(d['unverified']).toBe(false);
  });

  it('flags uncited scatter as unverified', () => {
    const doc = modelDoc([normal('R', 300, 30, false), normal('S', 200, 40)], 'R - S');
    const d = data(indices({ samples: 256 }, doc));
    expect(d['unverified']).toBe(true);
    expect((d['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_SCATTER_UNSOURCED');
  });

  it('refuses without changing the document', () => {
    const doc = ishigamiDoc();
    const refused = (params: Json, doc2 = doc): string | undefined => {
      const result = indices(params, doc2);
      expect(result.document).toBe(doc2);
      expect(result.affected).toEqual([]);
      return code(result);
    };
    expect(refused({ limitState: undefined })).toBe('PRB_PARAMS_INVALID');
    expect(refused({ response: 'mass' })).toBe('PRB_PARAMS_INVALID');
    expect(refused({ limitState: 'nope' })).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    expect(refused({ limitState: undefined, response: 'nope' })).toBe('PRB_RESPONSE_NOT_FOUND');
    expect(refused({ samples: 500_000 })).toBe('PRB_BUDGET_EXCEEDED');
    const constant = modelDoc([normal('R', 300, 30)], '5 + 0 * R');
    expect(refused({ samples: 64 }, constant)).toBe('PRB_VARIANCE_ZERO');
    const failing = modelDoc([normal('R', 300, 30)], 'ln(310 - R)');
    expect(refused({ samples: 64 }, failing)).toBe('PRB_RESPONSE_FAILED');
    const correlated = execute(modelDoc([normal('R', 300, 30), normal('S', 200, 40)], 'R - S'), 'set_correlation', {
      names: ['R', 'S'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    }).document;
    expect(refused({ samples: 64 }, correlated)).toBe('PRB_SOBOL_CORRELATED');
  });
});
