import { describe, it, expect } from 'vitest';
import { formatQuantities, formatSignificant } from '@ui/panels/analysis/quantityFormat';

describe('quantityFormat', () => {
  it('keeps significant figures instead of a fixed decimal count', () => {
    expect(formatSignificant(0.0123456)).toBe('0.01235');
    expect(formatSignificant(224756.1869)).toBe('224800');
    expect(formatSignificant(416.6587, 5)).toBe('416.66');
  });

  it('uses exponent form for very small and very large values', () => {
    expect(formatSignificant(-9.52e-5)).toBe('-9.52e-5');
    expect(formatSignificant(2.5e8)).toBe('2.5e8');
  });

  it('never prints negative zero', () => {
    expect(formatSignificant(-0)).toBe('0');
    expect(formatQuantities([-0], 'J').texts).toEqual(['0']);
  });

  it('scales Pa and m to a shared display unit', () => {
    expect(formatQuantities([224756.1869, 14920000], 'Pa')).toEqual({ texts: ['0.2248', '14.92'], unit: 'MPa' });
    expect(formatQuantities([-9.522e-5], 'm')).toEqual({ texts: ['-0.09522'], unit: 'mm' });
    expect(formatQuantities([2, 5], 'm').unit).toBe('m');
    expect(formatQuantities([20, 85.5], 'degC')).toEqual({ texts: ['20', '85.5'], unit: 'degC' });
  });
});
