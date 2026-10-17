/** Pure CTE conversions (PHY-04 5.2, TR-TMC-15). */
import { describe, expect, it } from 'vitest';
import { linearLaw, reReferenceSecant, sampledIntegral, secantFromInstantaneous, secantStrain, tableLaw } from '@core/model/cteConversion';

describe('cteConversion', () => {
  const law = linearLaw(2.2e-5, 1e-8, 20);

  it('secant of a linear law is exact and equals the instantaneous value at the reference', () => {
    expect(secantFromInstantaneous(law, 20, 120)).toBeCloseTo(2.25e-5, 17);
    expect(secantFromInstantaneous(law, 20, 20)).toBe(2.2e-5);
    expect(secantFromInstantaneous(law, 0, 120)).toBeCloseTo(2.24e-5, 17);
  });

  it('re-referencing reproduces the direct secant and the strain is reference independent', () => {
    const secant20 = (t: number): number => secantFromInstantaneous(law, 20, t);
    expect(reReferenceSecant(secant20, 20, 0, 120)).toBeCloseTo(secantFromInstantaneous(law, 0, 120), 17);
    expect(Number.isNaN(reReferenceSecant(secant20, 20, 0, 0))).toBe(true);
    expect(secantStrain(secant20, 20, 20)).toBe(0);
    const strain = (reference: number): number =>
      secantFromInstantaneous(law, reference, 120) * (120 - reference) - secantFromInstantaneous(law, reference, 20) * (20 - reference);
    expect(strain(0)).toBeCloseTo(strain(20), 15);
  });

  it('a piecewise-linear table integrates exactly, in either direction, and is NaN outside', () => {
    const table = tableLaw([
      [0, 1],
      [10, 3],
      [20, 3],
    ]);
    expect(table?.integral(0, 20)).toBe(20 + 30);
    expect(table?.integral(5, 15)).toBeCloseTo(((2 + 3) / 2) * 5 + 15, 12);
    expect(table?.integral(20, 0)).toBe(-50);
    expect(table?.integral(0, 25)).toBeNaN();
    expect(table?.alpha(-1)).toBeNaN();
    expect(table?.alpha(5)).toBe(2);
    expect(secantFromInstantaneous(table ?? law, 0, 10)).toBeCloseTo(2, 14);
  });

  it('rejects malformed tables', () => {
    expect(tableLaw([[0, 1]])).toBeUndefined();
    expect(
      tableLaw([
        [0, 1],
        [0, 2],
      ]),
    ).toBeUndefined();
    expect(
      tableLaw([
        [0, 1],
        [1, Number.NaN],
      ]),
    ).toBeUndefined();
  });

  it('Simpson sampling at <= 10 K steps reports its error estimate', () => {
    const exact = sampledIntegral((t) => 1e-5 + 1e-8 * t, 0, 100);
    expect(exact.value).toBeCloseTo(1e-5 * 100 + (1e-8 * 100 ** 2) / 2, 18);
    expect(exact.errorEstimate).toBeLessThan(1e-18);
    expect(exact.intervals).toBeGreaterThanOrEqual(12);
    const curved = sampledIntegral((t) => Math.exp(t / 50) * 1e-5, 0, 100);
    const truth = 1e-5 * 50 * (Math.exp(2) - 1);
    expect(Math.abs(curved.value - truth)).toBeLessThan(1e-4 * truth);
    expect(curved.errorEstimate).toBeGreaterThan(0.1 * Math.abs(curved.value - truth));
    expect(sampledIntegral((t) => t, 5, 5)).toEqual({ value: 0, errorEstimate: 0, intervals: 0 });
    expect(sampledIntegral((t) => t, 10, 0).value).toBeCloseTo(-50, 12);
  });
});
