import { describe, it, expect } from 'vitest';
import { lawFunction, lawIssue } from '@lib/law/evaluate';
import { integrateLaw } from '@lib/law/integrate';
import type { ScalarLaw } from '@lib/law/types';

const L = 100;

describe('lib/law — values', () => {
  it('constant, linear and s_curve follow their closed forms', () => {
    expect(lawFunction({ type: 'constant', value: 3 })(0.4, L)).toBe(3);
    expect(lawFunction({ type: 'linear', start: 1, end: 0.5 })(0.5, L)).toBeCloseTo(0.75, 15);
    const s: ScalarLaw = { type: 's_curve', start: 0, end: 2 };
    expect(lawFunction(s)(0.5, L)).toBeCloseTo(1, 15);
    expect(lawFunction(s)(0.25, L)).toBeCloseTo(2 * (3 * 0.0625 - 2 * 0.015625), 15);
  });
  it('a table is a shape-preserving cubic through its points, with the given end slopes', () => {
    const points = [
      [0, 1],
      [0.3, 2],
      [0.7, 0.5],
      [1, 3],
    ] as const;
    const f = lawFunction({ type: 'table', points });
    for (const [t, v] of points) expect(f(t, L)).toBeCloseTo(v, 12);
    const clamped = lawFunction({ type: 'table', points, startSlope: 0, endSlope: 0 });
    const h = 1e-6;
    expect((clamped(h, L) - clamped(0, L)) / h).toBeCloseTo(0, 3);
    expect((clamped(1, L) - clamped(1 - h, L)) / h).toBeCloseTo(0, 3);
    // no overshoot: between data the value stays inside the data range of that span
    for (let k = 0; k <= 200; k++) expect(f(k / 200, L)).toBeGreaterThanOrEqual(0.5 - 1e-12);
  });
  it('a step-like pitch table does not undershoot its plateaus (the spring plan of the pack)', () => {
    const f = lawFunction({
      type: 'table',
      points: [
        [0, 2],
        [0.125, 2],
        [0.2, 6],
        [0.8, 6],
        [0.875, 2],
        [1, 2],
      ],
    });
    for (let k = 0; k <= 400; k++) {
      const v = f(k / 400, L);
      expect(v).toBeGreaterThanOrEqual(2 - 1e-12);
      expect(v).toBeLessThanOrEqual(6 + 1e-12);
    }
  });
  it('a table reproduces a straight line exactly', () => {
    const f = lawFunction({
      type: 'table',
      points: [
        [0, 1],
        [0.5, 2],
        [1, 3],
      ],
    });
    expect(f(0.25, L)).toBeCloseTo(1.5, 12);
  });
  it('an expression sees t, s = t L and L', () => {
    const f = lawFunction({ type: 'expression', expression: 't + s / L + L * 0 + pi * 0' });
    expect(f(0.25, L)).toBeCloseTo(0.5, 12);
    expect(lawFunction({ type: 'expression', expression: '1 + 0.25*sin(2*pi*t)' })(0.25, L)).toBeCloseTo(1.25, 12);
  });
});

describe('lib/law — integrals', () => {
  it('matches the closed forms to 1e-12 (validation 4.5)', () => {
    const w: ScalarLaw = { type: 's_curve', start: 0, end: 1 };
    expect(integrateLaw(w, (v) => v, L)).toBeCloseTo(0.5, 12);
    expect(integrateLaw(w, (v) => v * v, L)).toBeCloseTo(13 / 35, 12);
    expect(integrateLaw({ type: 'linear', start: 1, end: 0.5 }, (v) => v * v, L)).toBeCloseTo((1 + 0.5 + 0.25) / 3, 12);
    expect(integrateLaw({ type: 'expression', expression: '1 + 0.25*sin(2*pi*t)' }, (v) => v * v, L)).toBeCloseTo(1.03125, 12);
    expect(
      integrateLaw(
        {
          type: 'table',
          points: [
            [0, 1],
            [0.4, 3],
            [1, 2],
          ],
        },
        (v) => v,
        L,
      ),
    ).toBeGreaterThan(1);
  });
});

describe('lib/law — validation', () => {
  const check = (law: ScalarLaw, positive = false): string | null => lawIssue(law, { positive, length: L })?.code ?? null;
  it('accepts valid laws', () => {
    expect(check({ type: 'linear', start: 1, end: 2 }, true)).toBeNull();
    expect(
      check(
        {
          type: 'table',
          points: [
            [0, 1],
            [1, 2],
          ],
        },
        true,
      ),
    ).toBeNull();
    expect(check({ type: 'expression', expression: '1 + t' }, true)).toBeNull();
  });
  it('refuses non-finite, mis-ordered and unparsable laws with SWG_LAW_INVALID', () => {
    expect(check({ type: 'constant', value: Number.NaN })).toBe('SWG_LAW_INVALID');
    expect(check({ type: 'linear', start: 0, end: Number.POSITIVE_INFINITY })).toBe('SWG_LAW_INVALID');
    expect(
      check({
        type: 'table',
        points: [
          [0, 0],
          [0.5, 1],
          [0.4, 2],
          [1, 3],
        ],
      }),
    ).toBe('SWG_LAW_INVALID');
    expect(check({ type: 'table', points: [[0, 0]] })).toBe('SWG_LAW_INVALID');
    expect(
      check({
        type: 'table',
        points: [
          [0.1, 0],
          [1, 1],
        ],
      }),
    ).toBe('SWG_LAW_INVALID');
    expect(
      check({
        type: 'table',
        points: [
          [0, 0],
          [1, Number.NaN],
        ],
      }),
    ).toBe('SWG_LAW_INVALID');
    expect(
      check({
        type: 'table',
        points: [
          [0, 0],
          [1, 1],
        ],
        startSlope: Number.NaN,
      }),
    ).toBe('SWG_LAW_INVALID');
    expect(check({ type: 'expression', expression: '1 +' })).toBe('SWG_LAW_INVALID');
    expect(check({ type: 'expression', expression: 'nope(t)' })).toBe('SWG_LAW_INVALID');
    expect(check({ type: 'expression', expression: '1 / (t - 0.5)' })).toBe('SWG_LAW_INVALID');
  });
  it('refuses a value <= 0 only when positivity is asked, reporting where', () => {
    const law: ScalarLaw = { type: 'linear', start: 1, end: -0.5 };
    expect(check(law, false)).toBeNull();
    const issue = lawIssue(law, { positive: true, length: L });
    expect(issue?.code).toBe('SWG_LAW_NONPOSITIVE');
    expect(issue?.t).toBeGreaterThan(0.6);
  });
});
