/**
 * Sizing arithmetic of PHY-23 DRV-M3 against the closed forms of drv_reference.json: the thermal network (VC-DRV-06 / 07 / 09), RMS over a duty
 * cycle (VC-DRV-08 / 12) and inertia matching (VC-DRV-11). Hand-computed values are labelled.
 */
import { describe, expect, it } from 'vitest';
import type { DcMotorDatasheet } from '@core/model/drives';
import {
  continuousCurrentAtLimit,
  networkTimeConstants,
  runawayCurrent,
  steadyWindingC,
  thermalParams,
  windingRiseAt,
  windingTemperatureSeries,
} from '@dynamics/sim/actuators/thermal';
import { inertiaMatchedRatio, marginOf, peakAbs, peakTorqueForInertialLoad, rmsOver } from '@dynamics/sim/sizing';
import { MAXON_SHEET, section } from './fixtures';

const sheet: DcMotorDatasheet = {
  ...MAXON_SHEET,
  thermal: { rthWindingHousingKPerW: 1.9, rthHousingAmbientKPerW: 4.7, tauWindingS: 41.5, tauMotorS: 809, maxWindingC: 155 },
};
const network = (alphaPerK?: number): NonNullable<ReturnType<typeof thermalParams>> => {
  const thermal = sheet.thermal;
  if (thermal === undefined) throw new Error('no thermal sheet');
  const params = thermalParams({ ...sheet, thermal: alphaPerK === undefined ? thermal : { ...thermal, alphaPerK } });
  if (params === null) throw new Error('no thermal network');
  return params;
};
const relative = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

interface ThermalReference {
  steadyAtNominalCurrentC: number;
  maxContinuousCurrentAt155CA: number;
  runawayCurrentA: number;
  transient10W: { timeConstantsS: [number, number]; samples: { tS: number; windingRiseK: number }[] };
  dutyCycle: { rmsCurrentA: number; rmsTorqueNm: number; steadyWindingAtRmsCurrentC: number };
}
const thermal = section<ThermalReference>('thermal');

describe('thermal network (VC-DRV-06 / 07 / 09)', () => {
  it('has no network without thermal data', () => {
    expect(thermalParams(MAXON_SHEET)).toBeNull();
  });

  it('VC-DRV-06: steady winding temperature 130.897 C at the nominal current 3.17 A (0.5 K), continuous current 3.401 A at 155 C', () => {
    const temperature = steadyWindingC(network(), 3.17, 25);
    expect(Math.abs((temperature ?? Number.NaN) - thermal.steadyAtNominalCurrentC)).toBeLessThan(0.5);
    expect(relative(continuousCurrentAtLimit(network(), 25), thermal.maxContinuousCurrentAt155CA)).toBeLessThan(1e-6);
    // the winding at that current sits at its limit (round trip of the two closed forms)
    expect(Math.abs((steadyWindingC(network(), continuousCurrentAtLimit(network(), 25), 25) ?? Number.NaN) - 155)).toBeLessThan(1e-9);
  });

  it('VC-DRV-09: runaway above 5.863 A (0.1 %), no steady state there', () => {
    expect(relative(runawayCurrent(network()), thermal.runawayCurrentA)).toBeLessThan(1e-3);
    expect(steadyWindingC(network(), 5.9, 25)).toBeNull();
    expect(steadyWindingC(network(), 5.8, 25)).not.toBeNull();
  });

  it('VC-DRV-07: 10 W step with alpha 0: winding rise at 10 .. 10000 s within 1 %, network time constants 916.5 / 36.63 s', () => {
    const [slow, fast] = networkTimeConstants(network(0));
    expect(slow).toBeCloseTo(thermal.transient10W.timeConstantsS[0], 3);
    expect(fast).toBeCloseTo(thermal.transient10W.timeConstantsS[1], 3);
    for (const sample of thermal.transient10W.samples)
      expect(relative(windingRiseAt(network(0), 10, sample.tS), sample.windingRiseK), `rise at ${sample.tS} s`).toBeLessThan(0.01);
  });

  it('the stepped series of a constant current agrees with the one-shot exponential (alpha 0, i^2 R = 10 W)', () => {
    const current = Math.sqrt(10 / 1.13);
    const times = Array.from({ length: 301 }, (_, k) => k);
    const { windingC, housingC } = windingTemperatureSeries(
      network(0),
      times,
      times.map(() => current),
      25,
    );
    expect(relative((windingC[300] ?? 0) - 25, windingRiseAt(network(0), 10, 300))).toBeLessThan(1e-12);
    expect(windingC[0]).toBe(25);
    expect(housingC[300] ?? 0).toBeGreaterThan(25);
  });

  it('VC-DRV-08: the periodic mean winding temperature of 6 A for 1 s, 0 A for 3 s is within 3 K of the steady value at the RMS current (115.92 C)', () => {
    const dt = 0.05;
    const periods = 1500;
    const times = Array.from({ length: periods * 80 + 1 }, (_, k) => k * dt);
    const current = times.map((t) => (t % 4 < 1 ? 6 : 0));
    const { windingC } = windingTemperatureSeries(network(), times, current, 25);
    const last = windingC.slice(-81, -1);
    const mean = last.reduce((sum, value) => sum + value, 0) / last.length;
    expect(Math.abs(mean - thermal.dutyCycle.steadyWindingAtRmsCurrentC)).toBeLessThan(3);
  });
});

describe('RMS over a window (VC-DRV-08 / 12)', () => {
  const edges = (high: number, off: number): { times: number[]; values: number[] } => ({
    times: [0, 1, 1, 4, 4, 5, 5, 8],
    values: [high, high, off, off, high, high, off, off],
  });

  it('VC-DRV-08: 6 A for 1 s then 0 A for 3 s, repeated: I_rms 3.000 A and T_rms 0.1809 N·m (1e-9, hand: sqrt(36 / 4))', () => {
    const { times, values } = edges(6, 0);
    expect(relative(rmsOver(times, values), thermal.dutyCycle.rmsCurrentA)).toBeLessThan(1e-9);
    expect(relative(rmsOver(times, values) * 0.0603, thermal.dutyCycle.rmsTorqueNm)).toBeLessThan(1e-9);
  });

  it('VC-DRV-12: 2 N·m for 1 s and 0 for 3 s has RMS 1.0 N·m (1e-9)', () => {
    const { times, values } = edges(2, 0);
    expect(relative(rmsOver(times, values), 1)).toBeLessThan(1e-9);
  });

  it('a constant, a ramp (hand: trapezoid of x^2 over [0,1,2] = (0.5 + 2.5) / 2 = 1.5) and the failure cases', () => {
    expect(rmsOver([0, 2], [3, 3])).toBe(3);
    expect(rmsOver([0, 1e-3, 2e-3], [0, 1, 2])).toBeCloseTo(Math.sqrt(1.5), 12);
    expect(rmsOver([0], [1])).toBeNaN();
    expect(rmsOver([1, 1], [1, 2])).toBeNaN();
    expect(peakAbs([1, -4, 3])).toBe(4);
    expect(peakAbs([])).toBe(0);
  });
});

describe('inertia matching (VC-DRV-11)', () => {
  const gear = section<{
    optimalRatio: {
      motorInertiaKgM2: number;
      loadInertiaKgM2: number;
      loadAccelerationRadS2: number;
      ratio: number;
      minPeakMotorTorqueNm: number;
      sweep: { ratio: number; peakMotorTorqueNm: number }[];
    };
  }>('gear').optimalRatio;

  it('the optimum is N = sqrt(J_L / J_m) = 10 and the minimum peak torque is 0.0274 N·m (hand: 2 alpha sqrt(J_m J_L))', () => {
    expect(relative(inertiaMatchedRatio(gear.motorInertiaKgM2, gear.loadInertiaKgM2), gear.ratio)).toBeLessThan(1e-9);
    const peak = peakTorqueForInertialLoad(gear.motorInertiaKgM2, gear.loadInertiaKgM2, gear.loadAccelerationRadS2, gear.ratio);
    expect(relative(peak, gear.minPeakMotorTorqueNm)).toBeLessThan(0.005);
    expect(relative(peak, 2 * gear.loadAccelerationRadS2 * Math.sqrt(gear.motorInertiaKgM2 * gear.loadInertiaKgM2))).toBeLessThan(1e-12);
  });

  it('every row of the reference sweep 2..50 is reproduced to 0.5 %', () => {
    for (const row of gear.sweep)
      expect(
        relative(
          peakTorqueForInertialLoad(gear.motorInertiaKgM2, gear.loadInertiaKgM2, gear.loadAccelerationRadS2, row.ratio),
          row.peakMotorTorqueNm,
        ),
        `N ${row.ratio}`,
      ).toBeLessThan(0.005);
  });

  it('margin is capacity / demand - 1 and absent without demand', () => {
    expect(marginOf(3, 2)).toBe(0.5);
    expect(marginOf(1, 2)).toBe(-0.5);
    expect(marginOf(1, 0)).toBeNull();
  });
});
