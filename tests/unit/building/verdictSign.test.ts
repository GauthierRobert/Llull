import { describe, expect, it } from 'vitest';
import { resistanceText, verdictSign } from '@aec/industrial/steelDesign/verdictSign';

describe('check line helpers', () => {
  it('sign: "≤" when the effect is within the resistance (equality included), ">" beyond', () => {
    expect(verdictSign(34, 4600)).toBe('≤');
    expect(verdictSign(100, 100)).toBe('≤');
    expect(verdictSign(34, 0.48)).toBe('>');
  });
  it('resistance: whole units from 10 up, two significant digits below', () => {
    expect(resistanceText(4621.4)).toBe('4621');
    expect(resistanceText(10)).toBe('10');
    expect(resistanceText(0.4761)).toBe('0.48');
    expect(resistanceText(3.14159)).toBe('3.1');
  });
});
