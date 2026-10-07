import { describe, it, expect } from 'vitest';
import { formatScaleBarLength } from '@ui/viewport/2d/gridHelpers';

describe('formatScaleBarLength', () => {
  it('uses as many decimals as the value needs', () => {
    expect(formatScaleBarLength(0.005)).toBe('0.005');
    expect(formatScaleBarLength(0.2)).toBe('0.2');
    expect(formatScaleBarLength(1)).toBe('1');
    expect(formatScaleBarLength(50)).toBe('50');
    expect(formatScaleBarLength(20000)).toBe('20000');
  });
  it('falls back to "0" for unusable lengths', () => {
    expect(formatScaleBarLength(0)).toBe('0');
    expect(formatScaleBarLength(Number.NaN)).toBe('0');
  });
});
