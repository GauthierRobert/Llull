import { describe, expect, it } from 'vitest';
import { bandByNominal, bandByNumber, octaveOfThird, OCTAVE_NOMINAL_HZ, THIRD_OCTAVE_NOMINAL_HZ } from '@cae/vibroacoustics/math/bands';
import { energySumDb, overallPressurePa, pressureToSpl, splToPressure } from '@cae/vibroacoustics/math/levels';
import { bandPsd, bandSplFromPsd } from '@cae/vibroacoustics/math/psd';
import { regroupThirdsToOctaves } from '@cae/vibroacoustics/math/regroup';
import { csvRows, expectedNumbers, THIRD_NOMINAL_27, withinCase } from './fixtures';

const nan = (value: number | undefined): number => value ?? Number.NaN;

describe('levels (TR-VAC-10, 12)', () => {
  it('VC-VAC-01: rms pressure of 94 / 120 / 140 / 150 dB', () => {
    const expected = expectedNumbers('VC-VAC-01');
    [94, 120, 140, 150].forEach((db, i) => expect(withinCase(splToPressure(db), nan(expected[i]), 'VC-VAC-01')).toBe(true));
  });
  it('VC-VAC-02: SPL of 1 Pa and 1 kPa', () => {
    const expected = expectedNumbers('VC-VAC-02');
    [1, 1000].forEach((pa, i) => expect(withinCase(pressureToSpl(pa), nan(expected[i]), 'VC-VAC-02')).toBe(true));
  });
  it('round trip p -> L -> p holds to 1e-12 relative (TR-VAC-10)', () => {
    for (const db of [-60, 0, 94, 130, 187.5, 300])
      expect(Math.abs(pressureToSpl(splToPressure(db)) - db)).toBeLessThan(1e-12 * Math.max(1, Math.abs(db)));
  });
  it('VC-VAC-06: 27 thirds at 130 dB sum to OASPL 144.313637642 dB', () => {
    expect(withinCase(energySumDb(THIRD_NOMINAL_27.map(() => 130)), nan(expectedNumbers('VC-VAC-06')[0]), 'VC-VAC-06')).toBe(true);
  });
  it('VC-VAC-07: 3 equal and 2 equal levels add 4.77 / 3.01 dB', () => {
    const [three, two] = expectedNumbers('VC-VAC-07');
    expect(Math.abs(energySumDb([100, 100, 100]) - 100 - nan(three))).toBeLessThan(1e-11);
    expect(Math.abs(energySumDb([100, 100]) - 100 - nan(two))).toBeLessThan(1e-11);
  });
  it('VC-VAC-08: five unequal bands', () => {
    expect(withinCase(energySumDb([120, 126, 131, 128, 122]), nan(expectedNumbers('VC-VAC-08')[0]), 'VC-VAC-08')).toBe(true);
  });
  it('VC-VAC-09: overall pressure two ways', () => {
    const levels = THIRD_NOMINAL_27.map(() => 130);
    const [viaLevel, viaSquares] = expectedNumbers('VC-VAC-09');
    expect(withinCase(overallPressurePa(levels), nan(viaLevel), 'VC-VAC-09')).toBe(true);
    expect(withinCase(Math.sqrt(levels.reduce((sum, db) => sum + splToPressure(db) ** 2, 0)), nan(viaSquares), 'VC-VAC-09')).toBe(true);
  });
  it('does not overflow for the largest accepted levels', () => {
    expect(energySumDb([300, 300])).toBeCloseTo(303.0103, 4);
  });
});

describe('bands (TR-VAC-11)', () => {
  it('VC-VAC-03: third octave at 1 kHz', () => {
    const band = bandByNominal('third_octave', 1000);
    const expected = expectedNumbers('VC-VAC-03');
    const actual = [band?.exactMidHz, band?.lowerHz, band?.upperHz, band?.bandwidthHz];
    expect(actual.map((value, i) => withinCase(nan(value), nan(expected[i]), 'VC-VAC-03'))).toEqual([true, true, true, true]);
  });
  it('VC-VAC-04: relative bandwidths of third and octave', () => {
    const [third, octave] = expectedNumbers('VC-VAC-04');
    const t = bandByNominal('third_octave', 1000);
    const o = bandByNominal('octave', 1000);
    expect(withinCase(nan(t?.bandwidthHz) / nan(t?.exactMidHz), nan(third), 'VC-VAC-04')).toBe(true);
    expect(withinCase(nan(o?.bandwidthHz) / nan(o?.exactMidHz), nan(octave), 'VC-VAC-04')).toBe(true);
  });
  it('VC-VAC-05: nominal 25 Hz is exactly 25.1189 Hz, 10 kHz is 10000 Hz', () => {
    const [low, high] = expectedNumbers('VC-VAC-05');
    expect(withinCase(nan(bandByNominal('third_octave', 25)?.exactMidHz), nan(low), 'VC-VAC-05')).toBe(true);
    expect(withinCase(nan(bandByNominal('third_octave', 10000)?.exactMidHz), nan(high), 'VC-VAC-05')).toBe(true);
  });
  it('every row of third_octave_bands.csv (25 Hz - 10 kHz) is reproduced', () => {
    const rows = csvRows('third_octave_bands.csv');
    expect(rows).toHaveLength(27);
    for (const row of rows) {
      const band = bandByNominal('third_octave', nan(row['nominal_Hz']));
      expect(band?.x).toBe(row['x']);
      const pairs: [number | undefined, string][] = [
        [band?.exactMidHz, 'exact_mid_Hz'],
        [band?.lowerHz, 'lower_edge_Hz'],
        [band?.upperHz, 'upper_edge_Hz'],
        [band?.bandwidthHz, 'bandwidth_Hz'],
      ];
      for (const [value, key] of pairs) expect(Math.abs(nan(value) / nan(row[key]) - 1)).toBeLessThan(1e-11);
    }
  });
  it('labels are looked up, never rounded; tables are complete', () => {
    expect(bandByNominal('third_octave', 1100)).toBeUndefined();
    expect(bandByNominal('third_octave', 1000.0001)).toBeUndefined();
    expect(bandByNominal('octave', 25)).toBeUndefined();
    expect(THIRD_OCTAVE_NOMINAL_HZ).toHaveLength(30);
    expect(OCTAVE_NOMINAL_HZ).toHaveLength(10);
    expect(bandByNumber('third_octave', 14)).toBeUndefined();
    expect(bandByNumber('octave', 4)?.nominalHz).toBe(16000);
  });
  it('octave edges equal the outer third edges (G^(1/2) = G^(1/6) G^(1/3))', () => {
    for (let k = -5; k <= 4; k += 1) {
      const octave = bandByNumber('octave', k);
      const lowThird = bandByNumber('third_octave', 3 * k - 1);
      const highThird = bandByNumber('third_octave', 3 * k + 1);
      expect(Math.abs(nan(octave?.lowerHz) / nan(lowThird?.lowerHz) - 1)).toBeLessThan(1e-13);
      expect(Math.abs(nan(octave?.upperHz) / nan(highThird?.upperHz) - 1)).toBeLessThan(1e-13);
      expect([3 * k - 1, 3 * k, 3 * k + 1].map(octaveOfThird)).toEqual([k, k, k]);
    }
  });
});

describe('band PSD (TR-VAC-13)', () => {
  it('VC-VAC-10: 130 dB third at 1 kHz and 100 Hz', () => {
    const [kHz, hundred] = expectedNumbers('VC-VAC-10');
    const a = bandByNominal('third_octave', 1000);
    const b = bandByNominal('third_octave', 100);
    expect(withinCase(bandPsd(130, nan(a?.lowerHz), nan(a?.upperHz)), nan(kHz), 'VC-VAC-10')).toBe(true);
    expect(withinCase(bandPsd(130, nan(b?.lowerHz), nan(b?.upperHz)), nan(hundred), 'VC-VAC-10')).toBe(true);
  });
  it('VC-VAC-11: SPL -> PSD -> SPL returns 130 dB', () => {
    const a = bandByNominal('third_octave', 1000);
    const psd = bandPsd(130, nan(a?.lowerHz), nan(a?.upperHz));
    expect(Math.abs(bandSplFromPsd(psd, nan(a?.lowerHz), nan(a?.upperHz)) - nan(expectedNumbers('VC-VAC-11')[0]))).toBeLessThan(1e-9);
  });
});

describe('regrouping (TR-VAC-14)', () => {
  it('VC-VAC-12: thirds 800 / 1000 / 1250 at 128 / 131 / 127 dB make octave 1 kHz', () => {
    const { octaves, omittedOctavesHz } = regroupThirdsToOctaves([
      { nominalHz: 800, splDb: 128 },
      { nominalHz: 1000, splDb: 131 },
      { nominalHz: 1250, splDb: 127 },
    ]);
    expect(octaves).toHaveLength(1);
    expect(octaves[0]?.nominalHz).toBe(1000);
    expect(withinCase(nan(octaves[0]?.splDb), nan(expectedNumbers('VC-VAC-12')[0]), 'VC-VAC-12')).toBe(true);
    expect(omittedOctavesHz).toEqual([]);
  });
  it('27 flat thirds give 9 complete octaves, each +4.7712 dB', () => {
    const { octaves, omittedOctavesHz } = regroupThirdsToOctaves(THIRD_NOMINAL_27.map((nominalHz) => ({ nominalHz, splDb: 130 })));
    expect(octaves.map((o) => o.nominalHz)).toEqual([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000]);
    for (const octave of octaves) expect(Math.abs(octave.splDb - 130 - 4.7712125472)).toBeLessThan(1e-9);
    expect(omittedOctavesHz).toEqual([]);
  });
  it('an incomplete octave is omitted and listed; a gap is not interpolated; unknown labels are ignored', () => {
    const { octaves, omittedOctavesHz } = regroupThirdsToOctaves([
      { nominalHz: 800, splDb: 128 },
      { nominalHz: 1000, splDb: 131 },
      { nominalHz: 2000, splDb: 100 },
      { nominalHz: 1111, splDb: 90 },
    ]);
    expect(octaves).toEqual([]);
    expect(omittedOctavesHz).toEqual([1000, 2000]);
  });
});
