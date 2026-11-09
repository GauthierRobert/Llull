/** Dryden turbulence of a flight scenario (13 FLT M4, TR-FLT-04): spectrum against the analytic PSD, variance, determinism, the wind source. */
import { describe, expect, it } from 'vitest';
import type { FlightWind } from '@dynamics/flight/controlModel';
import { drydenPsd, drydenSeries, TURBULENCE_STEP_S, type DrydenSpec } from '@dynamics/flight/turbulence';
import { isCalm, windAt, windSource } from '@dynamics/flight/wind';

const spec: DrydenSpec = { sigmaMps: [2, 1.5, 1], lengthScaleM: [100, 60, 40], airspeedMps: 20, seed: 12345 };

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let start = 0; start < n; start += len)
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(angle * k);
        const s = Math.sin(angle * k);
        const a = start + k;
        const b = a + len / 2;
        const tr = (re[b] as number) * c - (im[b] as number) * s;
        const ti = (re[b] as number) * s + (im[b] as number) * c;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
  }
}

/** Welch estimate (Hann window, 50 % overlap, segments of `size`) of the one-sided PSD in rad/s: bins k = 1 .. size/2 - 1 at ω = 2π k / (size dt). */
function welch(x: readonly number[], dt: number, size: number): { omega: number[]; psd: number[] } {
  const window = Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const power = window.reduce((sum, w) => sum + w * w, 0);
  const acc = new Float64Array(size / 2);
  let segments = 0;
  for (let start = 0; start + size <= x.length; start += size / 2) {
    const re = Float64Array.from({ length: size }, (_, i) => (x[start + i] as number) * (window[i] as number));
    const im = new Float64Array(size);
    fft(re, im);
    for (let k = 0; k < size / 2; k++) acc[k] = (acc[k] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    segments++;
  }
  // one-sided PSD per Hz = 2 dt |X|² / Σw², per rad/s divide by 2π
  const omega: number[] = [];
  const psd: number[] = [];
  for (let k = 1; k < size / 2; k++) {
    omega.push((2 * Math.PI * k) / (size * dt));
    psd.push((2 * dt * (acc[k] as number)) / (power * segments) / (2 * Math.PI));
  }
  return { omega, psd };
}

describe('Dryden turbulence (FLT-M4)', () => {
  // 20 independent realisations of the longest run (600 s): the estimates average out the chi-square scatter of a single record
  const seeds = Array.from({ length: 20 }, (_, k) => k + 1);
  const ensemble = seeds.map((seed) => drydenSeries({ ...spec, seed }, 120_001));
  const column = (run: number, axis: 0 | 1 | 2): number[] =>
    (ensemble[run] as readonly (readonly number[])[]).map((row) => row[axis] as number);

  it('the Welch spectrum of each component follows the analytic Dryden PSD (log-mean ratio within 5 %, every bin inside a factor 1.6)', () => {
    const size = 8192;
    for (const axis of [0, 1, 2] as const) {
      const estimates = seeds.map((_, run) => welch(column(run, axis), TURBULENCE_STEP_S, size));
      const omega = (estimates[0] as { omega: number[] }).omega;
      const mean = omega.map((_, i) => estimates.reduce((sum, e) => sum + (e.psd[i] as number), 0) / estimates.length);
      const corner = spec.airspeedMps / spec.lengthScaleM[axis];
      const band = omega.map((w, i) => ({ w, p: mean[i] as number })).filter(({ w }) => w >= corner / 4 && w <= corner * 10);
      expect(band.length).toBeGreaterThan(10);
      const logRatio = band.reduce((sum, { w, p }) => sum + Math.log(p / drydenPsd(spec, axis, w)), 0) / band.length;
      expect(Math.abs(Math.exp(logRatio) - 1)).toBeLessThan(0.05);
      for (const { w, p } of band) {
        expect(p / drydenPsd(spec, axis, w)).toBeGreaterThan(1 / 1.6);
        expect(p / drydenPsd(spec, axis, w)).toBeLessThan(1.6);
      }
    }
  });

  it('the analytic PSD integrates to sigma² and has the u / v / w forms (second-order rolloff for v, w)', () => {
    for (const axis of [0, 1, 2] as const) {
      let area = 0;
      const dw = 1e-3;
      for (let w = dw / 2; w < 4000; w += dw) area += drydenPsd(spec, axis, w) * dw;
      expect(area / spec.sigmaMps[axis] ** 2).toBeCloseTo(1, 2);
    }
    // high-frequency slopes: -2 for u (1/ω²), -2 for v / w (3 L²ω² / (Lω)⁴)
    const slope = (axis: 0 | 1 | 2): number => Math.log(drydenPsd(spec, axis, 2000) / drydenPsd(spec, axis, 1000)) / Math.log(2);
    expect(slope(0)).toBeCloseTo(-2, 2);
    expect(slope(1)).toBeCloseTo(-2, 2);
  });

  it('has the stated standard deviation and zero mean (pooled over the realisations)', () => {
    for (const axis of [0, 1, 2] as const) {
      const x = seeds.flatMap((_, run) => column(run, axis));
      const mean = x.reduce((sum, value) => sum + value, 0) / x.length;
      const variance = x.reduce((sum, value) => sum + (value - mean) ** 2, 0) / x.length;
      expect(Math.abs(Math.sqrt(variance) / spec.sigmaMps[axis] - 1)).toBeLessThan(0.05);
      expect(Math.abs(mean)).toBeLessThan(0.1 * spec.sigmaMps[axis]);
    }
  });

  it('is deterministic per seed and differs between seeds; sigma 0 gives still air', () => {
    expect(drydenSeries(spec, 500)).toEqual(drydenSeries(spec, 500));
    expect(drydenSeries({ ...spec, seed: 12346 }, 500)).not.toEqual(drydenSeries(spec, 500));
    // sample i does not depend on how many samples follow
    expect(drydenSeries(spec, 1000).slice(0, 500)).toEqual(drydenSeries(spec, 500));
    const calm = drydenSeries({ ...spec, sigmaMps: [0, 0, 0] }, 50);
    expect(calm.every((row) => row.every((value) => value === 0))).toBe(true);
    // a 2-sample floor and a cap at 600 s
    expect(drydenSeries(spec, 0)).toHaveLength(2);
    expect(drydenSeries(spec, 10_000_000)).toHaveLength(120_001);
  });
});

describe('the wind of a run', () => {
  const wind: FlightWind = { steady: [3, 0, 0], gusts: [{ startS: 1, durationS: 2, peak: [0, 0, 4] }], turbulence: spec };

  it('windSource = steady + 1-cosine gust + the realised turbulence, linear between samples and held after the end', () => {
    const source = windSource(wind, 5);
    const series = drydenSeries(spec, Math.ceil(5 / TURBULENCE_STEP_S) + 2);
    const gust = windAt(wind, 2);
    expect(gust).toEqual([3, 0, 4]);
    const at = (k: number): number[] => [
      3 + (series[k]?.[0] as number),
      series[k]?.[1] as number,
      (series[k]?.[2] as number) + windAt(wind, k * TURBULENCE_STEP_S)[2],
    ];
    const exact = source(200 * TURBULENCE_STEP_S);
    expect(exact[0]).toBeCloseTo(at(200)[0] as number, 12);
    expect(exact[2]).toBeCloseTo(at(200)[2] as number, 12);
    const between = source(200.5 * TURBULENCE_STEP_S);
    expect(between[1]).toBeCloseTo(((series[200]?.[1] as number) + (series[201]?.[1] as number)) / 2, 12);
    expect(source(-1)[1]).toBeCloseTo(series[0]?.[1] as number, 12);
    expect(source(1e6)[1]).toBeCloseTo(series[series.length - 1]?.[1] as number, 12);
    expect(windSource(wind, 5)(1.234)).toEqual(source(1.234));
  });

  it('without turbulence windSource is windAt, and isCalm only when nothing blows', () => {
    const plain: FlightWind = { steady: [1, 2, 3], gusts: [] };
    expect(windSource(plain, 10)(3)).toEqual([1, 2, 3]);
    expect(isCalm({ steady: [0, 0, 0], gusts: [] })).toBe(true);
    expect(isCalm({ steady: [0, 0, 0], gusts: [], turbulence: spec })).toBe(false);
    expect(isCalm(plain)).toBe(false);
  });
});
