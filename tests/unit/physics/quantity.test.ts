/** lib/quantity: unit grammar shared by the PHY-00 judge and PHY-01 property models. */
import { describe, expect, it } from 'vitest';
import { convertValue, isUnitFailure, parseUnit } from '@lib/quantity';

const convert = (value: number, from: string, to: string): number => {
  const result = convertValue(value, from, to);
  if (isUnitFailure(result)) throw new Error(result.message);
  return result.value;
};

describe('lib/quantity', () => {
  it('converts prefixed and compound units', () => {
    expect(convert(92.7e6, 'Pa', 'MPa')).toBeCloseTo(92.7, 12);
    expect(convert(1, 'W/(m*K)', 'W/(mm*K)')).toBeCloseTo(1e-3, 15);
    expect(convert(1, 'J/(kg*K)', 'J/(g*K)')).toBeCloseTo(1e-3, 15);
    expect(convert(1, 'ksi', 'MPa')).toBeCloseTo(6.894757293168361, 12);
    expect(convert(1, 'kJ/mol', 'J/mol')).toBe(1000);
    expect(convert(2, 'm^2', 'mm^2')).toBeCloseTo(2e6, 6);
    expect(convert(1, 'h', 's')).toBe(3600);
    expect(convert(1, 'N·m', 'J')).toBe(1);
    expect(convert(100, '%', '1')).toBe(1);
    expect(convert(1, '1e-5', 'ppm')).toBeCloseTo(10, 12);
    expect(convert(1, '1/degC', '1/K')).toBe(1);
  });

  it('converts absolute temperatures affinely', () => {
    expect(convert(-196, 'degC', 'K')).toBeCloseTo(77.15, 12);
    expect(convert(-320, 'degF', 'K')).toBeCloseTo(77.59444444444, 9);
    expect(convert(212, 'degF', 'degC')).toBeCloseTo(100, 12);
  });

  it('refuses unknown units and mismatched dimensions', () => {
    for (const bad of ['furlong', 'm^', '(m', 'm*', '', 'kmin', '0']) expect(isUnitFailure(parseUnit(bad)), bad).toBe(true);
    const mismatch = convertValue(1, 'MPa', 'mm');
    expect(isUnitFailure(mismatch) && mismatch.code).toBe('MAT_UNIT_DIMENSION');
    expect(isUnitFailure(convertValue(1, 'x', 'm')) && 'invalid').toBe('invalid');
    expect(isUnitFailure(convertValue(1, 'm', 'x'))).toBe(true);
  });
});
