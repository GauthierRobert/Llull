import { describe, expect, it } from 'vitest';
import { compactNumber, significantNumber } from '@lib/compactNumber';

describe('compactNumber', () => {
  it('rounds to 4 decimals without trailing zeros', () => {
    expect(compactNumber(1.23456789)).toBe('1.2346');
    expect(compactNumber(2.5)).toBe('2.5');
  });
});

describe('significantNumber', () => {
  it('rounds to significant digits without trailing zeros', () => {
    expect(significantNumber(7850.123, 3)).toBe('7850');
    expect(significantNumber(0.1 + 0.2, 6)).toBe('0.3');
    expect(significantNumber(1.5e21, 3)).toBe('1.5e+21');
  });
});
