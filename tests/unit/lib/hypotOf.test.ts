import { describe, expect, it } from 'vitest';
import { hypotOf } from '@lib/hypotOf';

describe('hypotOf', () => {
  it('is bit-identical to Math.hypot of the spread on a random corpus (1–9 values, many magnitudes)', () => {
    let state = 987654321;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    for (let list = 0; list < 20_000; list++) {
      const length = 1 + Math.floor(next() * 9);
      const values = Array.from({ length }, () => (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20));
      expect(Object.is(hypotOf(values), Math.hypot(...values)), values.join(',')).toBe(true);
    }
  });

  it('matches the fixed-arity calls the codemod replaced (tuples)', () => {
    for (const [x, y, z] of [
      [3, 4, 12],
      [0.1, 0.2, 0.3],
      [1e-300, 1e-300, 0],
      [1e300, 1e300, 1e300],
      [-2.5, 7.25, -1e-8],
    ] as const) {
      expect(Object.is(hypotOf([x, y, z]), Math.hypot(x, y, z))).toBe(true);
      expect(Object.is(hypotOf([x, y]), Math.hypot(x, y))).toBe(true);
    }
  });

  it('pins the special values like Math.hypot', () => {
    for (const values of [
      [],
      [0],
      [-0],
      [-0, -0],
      [NaN],
      [NaN, Infinity],
      [Infinity, NaN],
      [-Infinity],
      [NaN, 0],
      [5],
      [-5],
      [Number.MIN_VALUE],
    ]) {
      expect(Object.is(hypotOf(values), Math.hypot(...values)), values.join(',')).toBe(true);
    }
  });

  it('handles 1e6 values where the spread throws RangeError', () => {
    const values = new Float64Array(1_000_000).fill(1);
    expect(() => Math.hypot(...values)).toThrow(RangeError);
    expect(hypotOf(values)).toBe(1000);
  });
});
