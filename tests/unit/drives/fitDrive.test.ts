/**
 * fit_drive_parameters (PHY-23 DRV-M3, TR-DRV-25): VC-DRV-29 (spin-down fit and its unidentifiable variant) and synthetic spin-up / step data
 * generated from closed forms written out in the test (hand-computed, labelled), with the coded refusals.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectedResults, section } from './fixtures';

interface FitData {
  model: string;
  values: Record<string, { value: number; sigma: number | null; unit: string }>;
  residualRms: number;
  samplesUsed: number;
  condition: number;
  neglected: string[];
}
const doc = createEmptyDocument();
const fit = (params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, 'fit_drive_parameters', params);
const dataOf = (result: ReturnType<typeof execute>): FitData => result.data as FitData;
const errorOf = (result: ReturnType<typeof execute>): { code: string; ids: string[]; remediation: string } =>
  (result as unknown as { error: { code: string; ids: string[]; remediation: string } }).error;
const relative = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

/** Deterministic pseudo-noise in [-1, 1] (a linear congruential generator, no Math.random). */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state / 4294967296) * 2 - 1;
  };
}

const spin = section<{
  inertiaKgM2: number;
  coulombTorqueNm: number;
  viscousNmsPerRad: number;
  samples: { tS: number; speedRadS: number }[];
}>('spinDown');
const spinSeries = { t: spin.samples.map((s) => s.tS), omega: spin.samples.map((s) => s.speedRadS) };

describe('mechanical fit from a spin-down (VC-DRV-29)', () => {
  const pinned = (index: number): number => expectedResults.cases.filter((c) => c.id === 'VC-DRV-29')[index]?.value ?? Number.NaN;

  it('J known: recovers T_f within 0.5 % and b within 2 % from the six reference samples', () => {
    const result = fit({ series: spinSeries, unknowns: ['coulombNm', 'viscousNmsPerRad'], known: { inertia: spin.inertiaKgM2 } });
    const data = dataOf(result);
    expect(data.model).toBe('mechanical');
    expect(relative(data.values['coulombNm']!.value, pinned(0))).toBeLessThan(0.005);
    expect(relative(data.values['viscousNmsPerRad']!.value, pinned(1))).toBeLessThan(0.02);
    // the samples next to the stop (t = 2.0 needs t = 2.5, already at rest) are skipped: 3 equations for 2 unknowns
    expect(data.samplesUsed).toBe(3);
    expect(data.values['coulombNm']!.unit).toBe('N*m');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('J unknown too: DRV_FIT_UNIDENTIFIABLE naming J and the Coulomb friction, with a remediation', () => {
    const result = fit({ series: spinSeries, unknowns: ['inertia', 'coulombNm', 'viscousNmsPerRad'] });
    expect(errorOf(result).code).toBe('DRV_FIT_UNIDENTIFIABLE');
    expect(errorOf(result).ids).toEqual(['inertia', 'coulombNm']);
    expect(errorOf(result).remediation).toMatch(/known torque|measured J/);
    expect(result.summary).toMatch(/homogeneous/);
    expect(result.document).toBe(doc);
  });

  /** RK4 integration of J w' = tau(t) - Tf sign(w) - b w, sampled every 0.05 s (the hand-written plant of these two tests). */
  const plant = (torque: (t: number) => number): { t: number[]; omega: number[]; torque: number[] } => {
    const [inertia, coulomb, viscous] = [2e-5, 4e-3, 2e-6];
    const rate = (time: number, w: number): number => (torque(time) - (w > 0 ? coulomb : 0) - viscous * w) / inertia;
    const out = { t: [] as number[], omega: [] as number[], torque: [] as number[] };
    let w = 0;
    for (let k = 0; k <= 600; k++) {
      const time = k * 0.05;
      out.t.push(time);
      out.omega.push(w);
      out.torque.push(torque(time));
      for (let j = 0; j < 50; j++) {
        const [t0, h] = [time + j * 0.001, 0.001];
        const k1 = rate(t0, w);
        const k2 = rate(t0 + h / 2, w + (h / 2) * k1);
        const k3 = rate(t0 + h / 2, w + (h / 2) * k2);
        const k4 = rate(t0 + h, w + h * k3);
        w += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      }
    }
    return out;
  };

  it('a spin-up under a varying measured torque separates J, T_f and b (hand-written plant, 0.5 % each)', () => {
    const series = plant((time) => 0.03 + 0.02 * Math.sin((2 * Math.PI * time) / 8));
    const data = dataOf(fit({ series, unknowns: ['inertia', 'coulombNm', 'viscousNmsPerRad'] }));
    expect(relative(data.values['inertia']!.value, 2e-5)).toBeLessThan(0.005);
    expect(relative(data.values['coulombNm']!.value, 4e-3)).toBeLessThan(0.005);
    expect(relative(data.values['viscousNmsPerRad']!.value, 2e-6)).toBeLessThan(0.02);
    expect(data.condition).toBeLessThan(1e8);
  });

  it('a spin-up at one constant torque is structurally unidentifiable: dw/dt = (tau - Tf)/J - (b/J) w has two combinations for three unknowns', () => {
    const result = fit({ series: plant(() => 0.05), unknowns: ['inertia', 'coulombNm', 'viscousNmsPerRad'] });
    expect(errorOf(result).code).toBe('DRV_FIT_UNIDENTIFIABLE');
    expect(result.summary).toMatch(/condition number/);
  });

  it('noisy data (J known, torque measured): the fitted friction lies within 4 sigma of the truth and sigma is reported', () => {
    const next = noise(7);
    const [inertia, coulomb, viscous, torque] = [2e-5, 4e-3, 2e-6, 0.05];
    const t = Array.from({ length: 401 }, (_, k) => k * 0.1);
    const omega = t.map((time) => ((torque - coulomb) / viscous) * (1 - Math.exp((-viscous * time) / inertia)) * (1 + 1e-4 * next()));
    const data = dataOf(
      fit({ series: { t, omega, torque: t.map(() => torque) }, unknowns: ['coulombNm', 'viscousNmsPerRad'], known: { inertia } }),
    );
    for (const [name, truth] of [
      ['coulombNm', coulomb],
      ['viscousNmsPerRad', viscous],
    ] as const) {
      const value = data.values[name]!;
      expect(value.sigma).toBeGreaterThan(0);
      expect(Math.abs(value.value - truth)).toBeLessThan(4 * (value.sigma ?? 0));
    }
    expect(data.residualRms).toBeGreaterThan(0);
  });

  it('a constant-speed record cannot separate Coulomb from viscous friction: unidentifiable pair (the columns are collinear)', () => {
    const t = Array.from({ length: 20 }, (_, k) => k * 0.1);
    const result = fit({ series: { t, omega: t.map(() => 100), torque: t.map(() => 0.01) }, unknowns: ['coulombNm', 'viscousNmsPerRad'] });
    expect(errorOf(result).code).toBe('DRV_FIT_UNIDENTIFIABLE');
    expect(errorOf(result).ids.sort()).toEqual(['coulombNm', 'viscousNmsPerRad']);
  });
});

describe('electrical fit from a step response', () => {
  const [resistance, kt, inductance] = [1.13, 0.0603, 0.33e-3];
  const t = Array.from({ length: 200 }, (_, k) => k * 1e-4);
  // two independent smooth signals so that i and w are not collinear
  const current = t.map((time) => 3 + 2 * Math.sin(2 * Math.PI * 30 * time));
  const omega = t.map((time) => 400 + 150 * Math.cos(2 * Math.PI * 17 * time + 1));

  it('u = R i + kt w: recovers R and kt to 1e-9 from exact data (L neglected and listed)', () => {
    const voltage = t.map((_, k) => resistance * current[k]! + kt * omega[k]!);
    const result = fit({ series: { t, omega, current, voltage }, unknowns: ['resistance', 'torqueConstant'] });
    const data = dataOf(result);
    expect(data.model).toBe('electrical');
    expect(relative(data.values['resistance']!.value, resistance)).toBeLessThan(1e-9);
    expect(relative(data.values['torqueConstant']!.value, kt)).toBeLessThan(1e-9);
    expect(data.neglected[0]).toMatch(/inductance/);
    expect(data.residualRms).toBeLessThan(1e-9);
  });

  it('with known.inductance the L di/dt term is used (hand: di/dt = 2*2pi*30 cos(2pi 30 t)), recovering R and kt to 0.1 %', () => {
    const slope = t.map((time) => 2 * 2 * Math.PI * 30 * Math.cos(2 * Math.PI * 30 * time));
    const voltage = t.map((_, k) => resistance * current[k]! + inductance * slope[k]! + kt * omega[k]!);
    const data = dataOf(fit({ series: { t, omega, current, voltage }, unknowns: ['resistance', 'torqueConstant'], known: { inductance } }));
    expect(relative(data.values['resistance']!.value, resistance)).toBeLessThan(1e-3);
    expect(relative(data.values['torqueConstant']!.value, kt)).toBeLessThan(1e-3);
    expect(data.neglected).toEqual([]);
  });

  it('speed proportional to current: R and kt are confounded (DRV_FIT_UNIDENTIFIABLE)', () => {
    const proportional = current.map((value) => 100 * value);
    const voltage = t.map((_, k) => resistance * current[k]! + kt * proportional[k]!);
    const result = fit({ series: { t, omega: proportional, current, voltage }, unknowns: ['resistance', 'torqueConstant'] });
    expect(errorOf(result).code).toBe('DRV_FIT_UNIDENTIFIABLE');
    expect(errorOf(result).ids.sort()).toEqual(['resistance', 'torqueConstant']);
  });

  it('one unknown with the other known fits it alone', () => {
    const voltage = t.map((_, k) => resistance * current[k]! + kt * omega[k]!);
    const data = dataOf(fit({ series: { t, omega, current, voltage }, unknowns: ['resistance'], known: { torqueConstant: kt } }));
    expect(relative(data.values['resistance']!.value, resistance)).toBeLessThan(1e-9);
  });
});

describe('fit_drive_parameters refusals', () => {
  const series = { t: [0, 1, 2, 3], omega: [4, 3, 2, 1] };

  it('no-ops with the reason: mixed unknowns, a name in both lists, a known that does not belong, unknown reference ids, missing channels', () => {
    expect(fit({ series, unknowns: ['inertia', 'resistance'] }).summary).toMatch(/separate calls/);
    expect(fit({ series, unknowns: ['coulombNm'], known: { coulombNm: 1 } }).summary).toMatch(/both unknown and known/);
    expect(fit({ series, unknowns: ['coulombNm'], known: { resistance: 1 } }).summary).toMatch(/does not belong to a mechanical fit/);
    expect(fit({ series: { omega: 'ghost' }, unknowns: ['coulombNm'] }).summary).toMatch(/no reference series 'ghost'/);
    expect(errorOf(fit({ series, unknowns: ['resistance', 'torqueConstant'] })).code).toBe('DRV_FIT_DATA');
  });

  it('DRV_FIT_DATA: fewer usable samples than unknowns, a non-increasing time, mismatched lengths', () => {
    expect(errorOf(fit({ series: { t: [0, 1, 2], omega: [3, 2, 1] }, unknowns: ['coulombNm', 'viscousNmsPerRad'] })).code).toBe(
      'DRV_FIT_DATA',
    );
    expect(fit({ series: { t: [0, 1, 1, 2], omega: [4, 3, 2, 1] }, unknowns: ['coulombNm'] }).summary).toMatch(/strictly increasing/);
    expect(fit({ series: { t: [0, 1, 2, 3], omega: [4, 3, 2, 1], torque: [1] }, unknowns: ['coulombNm'] }).summary).toMatch(
      /one value per time/,
    );
  });

  it('rejects schema violations (no unknowns, an unknown name, too few times)', () => {
    expect(fit({ series, unknowns: [] }).summary).toMatch(/rejected: invalid params/);
    expect(fit({ series, unknowns: ['mass'] }).summary).toMatch(/rejected: invalid params/);
    expect(fit({ series: { t: [0, 1], omega: [1, 2] }, unknowns: ['coulombNm'] }).summary).toMatch(/rejected: invalid params/);
  });
});
