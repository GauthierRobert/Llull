import { describe, expect, it } from 'vitest';
import { powInt } from '@lib/powInt';

describe('powInt', () => {
  it('is the left-to-right product, bit for bit', () => {
    for (const x of [0.1, 1.7, -2.3, 3.141592653589793, 1e-9, 12345.678]) {
      expect(powInt(x, 3)).toBe(x * x * x);
      expect(powInt(x, 4)).toBe(x * x * x * x);
      expect(powInt(x, 5)).toBe(x * x * x * x * x);
      expect(powInt(x, -2)).toBe(1 / (x * x));
      expect(powInt(x, -3)).toBe(1 / (x * x * x));
    }
  });

  it('handles the edge exponents and special values like a product would', () => {
    expect(powInt(7.5, 0)).toBe(1);
    expect(powInt(7.5, 1)).toBe(7.5);
    expect(powInt(0, 3)).toBe(0);
    expect(powInt(0, -2)).toBe(Infinity);
    expect(powInt(-2, 3)).toBe(-8);
    expect(powInt(Number.NaN, 3)).toBeNaN();
    expect(powInt(Infinity, 4)).toBe(Infinity);
  });

  it('stays within a few ulp of the built-in power', () => {
    for (const x of [0.37, 2.5, 19.25, 1234.5]) {
      for (const n of [3, 4, 5, -2]) expect(Math.abs(powInt(x, n) / x ** n - 1)).toBeLessThan(1e-15);
    }
  });
});
