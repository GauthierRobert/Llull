import { describe, expect, it } from 'vitest';
import { analyseSimpleBeam, loadTotals } from '@aec/industrial/steelBeamAnalysis';
import { pipeWallThickness, pipeWeightPerMetre } from '@aec/industrial/pipeWeight';

const ULS = { permanent: 1.35, imposed: 1.5 };
const ONE = { permanent: 1, imposed: 1 };
/** E·I of 10 000 cm⁴ in kNm²: 210 000 N/mm² × 1e8 mm⁴ = 2.1e4 kNm². */
const EI = 2.1e4;

describe('analyseSimpleBeam', () => {
  it('matches wL²/8, wL/2 and 5wL⁴/384EI for a uniform load', () => {
    const [w, length] = [10, 6];
    const response = analyseSimpleBeam(
      length,
      [{ from: 0, to: length, permanent: w, imposed: 0 }],
      [],
      ONE,
      EI,
    );
    expect(response.maxMoment).toBeCloseTo((w * length ** 2) / 8, 9);
    expect(response.momentAt).toBeCloseTo(length / 2, 9);
    expect(response.reactionStart).toBeCloseTo((w * length) / 2, 9);
    expect(response.reactionEnd).toBeCloseTo((w * length) / 2, 9);
    expect(response.maxShear).toBeCloseTo((w * length) / 2, 9);
    expect(response.shearAtMoment).toBe(0);
    const expected = ((5 * w * length ** 4) / (384 * EI)) * 1000;
    expect(Math.abs(response.deflection - expected) / expected).toBeLessThan(2e-3);
  });

  it('matches PL/4, PL³/48EI and the lever rule for point loads', () => {
    const [load, length] = [100, 8];
    const centred = analyseSimpleBeam(
      length,
      [],
      [{ at: 4, permanent: load, imposed: 0 }],
      ONE,
      EI,
    );
    expect(centred.maxMoment).toBeCloseTo((load * length) / 4, 9);
    expect(centred.shearAtMoment).toBeCloseTo(load / 2, 9);
    const expected = ((load * length ** 3) / (48 * EI)) * 1000;
    expect(Math.abs(centred.deflection - expected) / expected).toBeLessThan(2e-3);
    const eccentric = analyseSimpleBeam(length, [], [{ at: 2, permanent: load, imposed: 0 }], ONE);
    expect(eccentric.reactionStart).toBeCloseTo(75, 9);
    expect(eccentric.reactionEnd).toBeCloseTo(25, 9);
    expect(eccentric.maxMoment).toBeCloseTo(150, 9);
    expect(eccentric.momentAt).toBeCloseTo(2, 9);
  });

  it('applies the permanent / imposed factors and superposes loads', () => {
    const response = analyseSimpleBeam(
      4,
      [{ from: 0, to: 4, permanent: 2, imposed: 3 }],
      [{ at: 2, permanent: 4, imposed: 6 }],
      ULS,
    );
    const q = 1.35 * 2 + 1.5 * 3;
    const p = 1.35 * 4 + 1.5 * 6;
    expect(response.maxMoment).toBeCloseTo((q * 16) / 8 + (p * 4) / 4, 9);
    expect(response.totalLoad).toBeCloseTo(q * 4 + p, 9);
  });

  it('handles a partial uniform load with the maximum inside the span', () => {
    // 20 kN/m on the first 3 m of a 6 m beam: RA = 20·3·4.5/6, zero shear at RA/q = 2.25 m
    const response = analyseSimpleBeam(6, [{ from: 0, to: 3, permanent: 20, imposed: 0 }], [], ONE);
    expect(response.reactionStart).toBeCloseTo(45, 9);
    expect(response.momentAt).toBeCloseTo(2.25, 9);
    expect(response.maxMoment).toBeCloseTo((45 * 45) / (2 * 20), 9);
  });

  it('returns zeros without loads and ignores zero-width pieces', () => {
    const empty = analyseSimpleBeam(5, [{ from: 2, to: 2, permanent: 9, imposed: 0 }], [], ONE, EI);
    expect(empty.maxMoment).toBe(0);
    expect(empty.reactionStart).toBe(0);
    expect(empty.deflection).toBe(0);
  });

  it('totals the permanent and imposed load of a load set', () => {
    expect(
      loadTotals(
        [{ from: 1, to: 3, permanent: 2, imposed: 1 }],
        [{ at: 1, permanent: 5, imposed: 0.5 }],
      ),
    ).toEqual({ permanent: 9, imposed: 2.5 });
  });
});

describe('pipe weight', () => {
  it('takes the standard wall of the tabulated outside diameter', () => {
    expect(pipeWallThickness(323.9)).toBe(9.53);
    expect(pipeWallThickness(114.3)).toBe(6.02);
    expect(pipeWallThickness(60.3)).toBe(3.91);
  });

  it('falls back to OD / 40 (minimum 2.5 mm) for an untabulated diameter', () => {
    expect(pipeWallThickness(700)).toBeCloseTo(17.5, 9);
    expect(pipeWallThickness(30)).toBe(2.5);
  });

  it('weighs DN300 water-filled pipe at about 147 kg/m', () => {
    // steel π/4 (0.3239² − 0.30484²) · 7850 + water π/4 · 0.30484² · 1000
    const kgPerMetre = (pipeWeightPerMetre(323.9, 1000) * 1000) / 9.80665;
    expect(kgPerMetre).toBeGreaterThan(146.5);
    expect(kgPerMetre).toBeLessThan(147.5);
  });

  it('weighs an empty pipe as the steel wall only and a zero diameter as nothing', () => {
    const empty = (pipeWeightPerMetre(323.9, 0) * 1000) / 9.80665;
    expect(empty).toBeCloseTo(73.9, 0);
    expect(pipeWeightPerMetre(0, 1000)).toBe(0);
  });
});
