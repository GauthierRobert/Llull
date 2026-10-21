import { describe, expect, it } from 'vitest';
import { formatArea } from '@ui/panels/aero/aeroData';
import { formatSi } from '@lib/siText';

describe('aero value formatting reads in natural units', () => {
  it('prefixes SI values so 1-999 leads', () => {
    expect(formatSi(5.67e-4, 'N')).toBe('567 µN');
    expect(formatSi(12.3, 'N')).toBe('12.3 N');
    expect(formatSi(15800, 'W')).toBe('15.8 kW');
    expect(formatSi(473, 'Pa')).toBe('473 Pa');
    expect(formatSi(0, 'N')).toBe('0 N');
    expect(formatSi(22200, 'N')).toBe('22.2 kN');
  });

  it('shows small areas in mm² / cm²', () => {
    expect(formatArea(4e-6)).toBe('4 mm²');
    expect(formatArea(4.2e-3)).toBe('42 cm²');
    expect(formatArea(0.42)).toBe('0.42 m²');
  });
});
