/**
 * size_drive (PHY-23 DRV-M3): the sizing arithmetic against an independent recomputation from the run series (hand-computed, labelled), the
 * thermal closed form, the ratio sweep and inertia match (VC-DRV-11 / 37), provenance (VC-DRV-34), the ledger (VC-DRV-38) and the coded refusals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { servoSizingDoc } from './sizingFixtures';
import { IDEAL_SHEET, inertiaBench, MAXON_SHEET, runSteps, type DriveSeriesData } from './fixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface Finding {
  code: string;
  status: string;
  ids: string[];
  value?: number;
  limit?: number;
  fix: string;
}
interface SizeData {
  demand: {
    peakCurrentA: number;
    rmsCurrentA: number;
    peakShaftTorqueNm: number;
    rmsShaftTorqueNm: number;
    peakSpeedRpm: number;
    limitedSamples: number;
  };
  margins: Record<string, number>;
  limiting: { factor: string; margin: number } | null;
  thermal: { steadyAtRmsC: number | null; runaway: boolean; runawayCurrentA: number; peakWindingC: number } | null;
  findings: Finding[];
  verdict: string;
  window: { seconds: number; basis: string };
  notEvaluated: string[];
  provenance: { lowest: { id: string; grade: string } | null; inputs: { id: string; grade: string }[] };
  ledger: { closureRelative: number; closure: string; regeneratedJ: number; transmissionLossJ: number } | null;
  sweep?: {
    rows: { reduction: number; peakShaftTorqueNm: number; inertiaRatio: number; error?: string }[];
    best: { reduction: number } | null;
    inertiaMatchedRatio: number;
    currentReduction: number;
  };
}
const dataOf = (result: ReturnType<typeof execute>): SizeData => result.data as SizeData;
const codes = (data: SizeData): string[] => data.findings.map((finding) => finding.code);

/** RMS and peak of a sampled series on its own grid, written out independently of the command (trapezoid of x^2). */
function trapezoidRms(times: readonly number[], values: readonly number[]): number {
  let [sum, span] = [0, 0];
  for (let k = 1; k < times.length; k++) {
    const h = times[k]! - times[k - 1]!;
    sum += (h * (values[k - 1]! ** 2 + values[k]! ** 2)) / 2;
    span += h;
  }
  return Math.sqrt(sum / span);
}

describe('size_drive on the servo sizing plan (UC-2)', () => {
  let doc: CadDocument;
  let base: ReturnType<typeof execute>;
  let data: SizeData;
  beforeAll(() => {
    doc = servoSizingDoc();
    base = execute(doc, 'size_drive', { motor: 'm_re40', duration: 1 });
    data = dataOf(base);
  }, 120_000);

  it('demand equals an independent recomputation from the run series (peak and trapezoid RMS), at the controller-derived step', () => {
    const run = execute(doc, 'simulate_motion', { duration: 1, timestep: 1e-4, sampleRate: 1000, detail: 'drives', energy: true });
    const series = (run.data as { drives: { m_re40: { series: DriveSeriesData } } }).drives.m_re40.series;
    expect(data.demand.peakCurrentA).toBe(Math.max(...series.currentA.map(Math.abs)));
    expect(data.demand.rmsCurrentA).toBeCloseTo(trapezoidRms(series.times, series.currentA), 12);
    expect(data.demand.rmsShaftTorqueNm).toBeCloseTo(trapezoidRms(series.times, series.shaftTorqueNm), 12);
    // the shaft torque is kt times the mean current: the peak torque is bounded by kt times the peak current (hand: 0.0603 N·m/A)
    expect(data.demand.peakShaftTorqueNm).toBeLessThanOrEqual(0.0603 * data.demand.peakCurrentA * (1 + 1e-9));
  });

  it('margins are capacity / demand - 1 against the sheet (nominal 3.17 A, stall 42.48 A, 12000 rpm) and the limiting factor is the smallest', () => {
    expect(data.margins['rms_current']).toBeCloseTo(3.17 / data.demand.rmsCurrentA - 1, 12);
    expect(data.margins['peak_current']).toBeCloseTo(48 / 1.13 / data.demand.peakCurrentA - 1, 12);
    expect(data.margins['speed']).toBeCloseTo(12000 / data.demand.peakSpeedRpm - 1, 12);
    expect(data.limiting?.factor).toBe('rms_current');
    expect(data.limiting?.margin).toBe(Math.min(...Object.values(data.margins)));
    expect(data.notEvaluated).toEqual([]);
  });

  it('the winding steady value is the closed form at the RMS current (hand: T = (Ta + k (1 - 25 a)) / (1 - k a), k = 6.6 K/W I^2 1.13 ohm)', () => {
    const k = 6.6 * data.demand.rmsCurrentA ** 2 * 1.13;
    const closedForm = (25 + k * (1 - 25 * 0.0039)) / (1 - k * 0.0039);
    expect(data.thermal?.steadyAtRmsC).toBeCloseTo(closedForm, 9);
    expect(data.thermal?.runaway).toBe(false);
    expect(data.thermal?.peakWindingC).toBeGreaterThanOrEqual(25);
    expect(data.thermal?.runawayCurrentA).toBeCloseTo(5.8635, 3);
  });

  it('VC-DRV-34: friction (grade C) is the lowest-grade input, DRV_PARAM_UNSOURCED lists exactly it, and regrading to B clears it', () => {
    expect(data.provenance.lowest).toMatchObject({ id: 'j_load.friction', grade: 'C' });
    const unsourced = data.findings.find((finding) => finding.code === 'DRV_PARAM_UNSOURCED');
    expect(unsourced).toMatchObject({ status: 'warn', ids: ['j_load.friction'] });
    const regraded = dataOf(execute(servoSizingDoc({ grade: 'B' }), 'size_drive', { motor: 'm_re40', duration: 1 }));
    expect(codes(regraded)).not.toContain('DRV_PARAM_UNSOURCED');
    expect(regraded.provenance.lowest?.grade).toBe('B');
  });

  it('verdict ok with the 20 % margin; the ledger closes (VC-DRV-38), energy is regenerated on deceleration and the gear loses', () => {
    expect(data.verdict).toBe('ok');
    expect(data.ledger?.closureRelative).toBeLessThanOrEqual(1e-3);
    expect(data.ledger?.closure).toBe('pass');
    expect(data.ledger?.regeneratedJ).toBeLessThan(0);
    expect(data.ledger?.transmissionLossJ).toBeGreaterThan(0);
  });

  it('VC-DRV-38: the gear loss is (1 - eta) of the transmitted energy: forward 1/eta - 1 of the load energy, back-driven 1 - eta_b (1e-3: measured 0.99994 of the prediction)', () => {
    const run = execute(doc, 'simulate_motion', { duration: 1, timestep: 1e-4, sampleRate: 1000, detail: 'series', energy: true });
    const series = (run.data as { series: { times: number[]; jointVelocity: Record<string, number[]> } }).series;
    const w = series.jointVelocity['j_load']!;
    const inertia = 0.5 * 1.096 * 0.05 ** 2;
    let [forward, back] = [0, 0];
    for (let k = 1; k < w.length - 1; k++) {
      const h = series.times[k + 1]! - series.times[k - 1]!;
      const alpha = (w[k + 1]! - w[k - 1]!) / h;
      const speed = w[k]!;
      const power = (inertia * alpha + 0.02 * Math.sign(speed) + 0.001 * speed) * speed;
      const dt = (series.times[k + 1]! - series.times[k - 1]!) / 2;
      if (power > 0) forward += (power * dt * (1 - 0.9)) / 0.9;
      else back += -power * dt * (1 - 0.88);
    }
    expect(Math.abs((forward + back) / (data.ledger?.transmissionLossJ ?? Number.NaN) - 1)).toBeLessThan(1e-3);
  });

  it('is pure: the document is returned unchanged, nothing is affected, no step is added', () => {
    const before = structuredClone(doc);
    const again = execute(doc, 'size_drive', { motor: 'm_re40', duration: 0.5 });
    expect(again.affected).toEqual([]);
    expect(again.document).toBe(doc);
    expect(doc).toEqual(before);
  });
});

describe('size_drive ratio sweep (VC-DRV-11 / 37)', () => {
  it('VC-DRV-37: the best reduction is within one sweep step of the inertia match sqrt(J_L / J_m) = 10, each row re-ran a copy, the stored gear is untouched', () => {
    const doc = servoSizingDoc();
    const before = structuredClone(doc);
    const result = execute(doc, 'size_drive', { motor: 'm_re40', duration: 1, ratioSweep: [5, 8, 10, 12, 15, 20] });
    const sweep = dataOf(result).sweep;
    expect(sweep?.rows.map((row) => row.reduction)).toEqual([5, 8, 10, 12, 15, 20]);
    expect(sweep?.rows.every((row) => row.error === undefined)).toBe(true);
    expect(sweep?.inertiaMatchedRatio).toBeCloseTo(10, 3);
    expect(sweep?.currentReduction).toBeCloseTo(10, 9);
    const steps = [5, 8, 10, 12, 15, 20];
    const matched = steps.indexOf(10);
    expect(Math.abs(steps.indexOf(sweep?.best?.reduction ?? Number.NaN) - matched)).toBeLessThanOrEqual(1);
    // the inertia ratio of a row is J_L / (N^2 J_m): 1 at N = 10, 4 at N = 5
    expect(sweep?.rows.find((row) => row.reduction === 10)?.inertiaRatio).toBeCloseTo(1, 4);
    expect(sweep?.rows.find((row) => row.reduction === 5)?.inertiaRatio).toBeCloseTo(4, 4);
    // the peak shaft torque is U shaped around the optimum (VC-DRV-11: 2 alpha sqrt(J_m J_L) at N = 10 for the ideal inertial part)
    const peaks = Object.fromEntries((sweep?.rows ?? []).map((row) => [row.reduction, row.peakShaftTorqueNm]));
    expect(peaks[10]!).toBeLessThan(peaks[5]!);
    expect(peaks[10]!).toBeLessThan(peaks[20]!);
    expect(doc).toEqual(before);
  }, 120_000);

  it('VC-DRV-37 (second half, factor corrected): a load heavy enough raises DRV_RMS_OVER and the verdict reads over', () => {
    // 4x the inertia only moves the RMS current to about 1 A against the 3.17 A rating (the plan's motor is oversized); 30x exceeds it
    const result = execute(servoSizingDoc({ loadScale: 30 }), 'size_drive', { motor: 'm_re40', duration: 1 });
    const heavy = dataOf(result);
    expect(codes(heavy)).toContain('DRV_RMS_OVER');
    expect(heavy.verdict).toBe('over');
    expect(heavy.limiting?.margin ?? 0).toBeLessThan(0);
    expect(['rms_current', 'thermal']).toContain(heavy.limiting?.factor);
    expect(codes(heavy).some((code) => code === 'DRV_THERMAL_OVER' || code === 'DRV_THERMAL_RUNAWAY')).toBe(true);
    const finding = heavy.findings.find((entry) => entry.code === 'DRV_RMS_OVER');
    expect(finding?.limit).toBe(3.17);
    expect(finding?.value).toBeGreaterThan(3.17);
  }, 120_000);
});

describe('size_drive thermal and limit findings', () => {
  const sheet = {
    ...MAXON_SHEET,
    thermal: { rthWindingHousingKPerW: 1.9, rthHousingAmbientKPerW: 4.7, tauWindingS: 41.5, tauMotorS: 809, maxWindingC: 155 },
  };
  const torqueBench = (amps: number): CadDocument =>
    inertiaBench(1e-3, { sheet }, [
      {
        command: 'add_motion_profile',
        params: { id: 'hold', quantity: 'torque', unit: 'N*m', start: 0.0603 * amps, segments: [{ kind: 'dwell', duration: 0.2 }] },
      },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 'hold' } },
    ]);

  it('6 A sustained is above the runaway current (5.863 A): DRV_THERMAL_RUNAWAY and DRV_RMS_OVER fail, verdict over (VC-DRV-09)', () => {
    const data = dataOf(execute(torqueBench(6), 'size_drive', { motor: 'm' }));
    expect(codes(data)).toEqual(expect.arrayContaining(['DRV_THERMAL_RUNAWAY', 'DRV_RMS_OVER']));
    expect(data.thermal?.runaway).toBe(true);
    expect(data.thermal?.steadyAtRmsC).toBeNull();
    expect(data.verdict).toBe('over');
    // the series starts with a zero sample (the output of the step that ended at t = 0), so the window RMS reads 0.1 % under the set current
    expect(data.demand.rmsCurrentA).toBeCloseTo(6, 1);
  });

  it('5 A sustained has a steady winding far above 155 C (hand: k = 6.6 * 25 * 1.13 = 186, T = (25 + 0.9025 k) / (1 - 0.0039 k) = 708 C): DRV_THERMAL_OVER (hand: k = 6.6 * 25 * 1.13)', () => {
    const data = dataOf(execute(torqueBench(5), 'size_drive', { motor: 'm' }));
    const k = 6.6 * data.demand.rmsCurrentA ** 2 * 1.13;
    expect(k).toBeCloseTo(6.6 * 25 * 1.13, -1);
    expect(data.thermal?.steadyAtRmsC).toBeCloseTo((25 + k * (1 - 25 * 0.0039)) / (1 - k * 0.0039), 6);
    expect(codes(data)).toContain('DRV_THERMAL_OVER');
    expect(codes(data)).toContain('DRV_RMS_OVER');
  });

  it('a margin above the headroom raises DRV_MARGIN_LOW and the verdict reads marginal', () => {
    const data = dataOf(execute(torqueBench(2.8), 'size_drive', { motor: 'm', margin: 0.2 }));
    expect(data.limiting?.factor).toBe('rms_current');
    expect(data.limiting?.margin).toBeCloseTo(3.17 / 2.8 - 1, 2);
    expect(codes(data)).toContain('DRV_MARGIN_LOW');
    expect(data.verdict).toBe('marginal');
  });

  it('a sheet without thermal data or nominal current lists what it could not evaluate instead of passing it', () => {
    const bare = inertiaBench(1e-3, { sheet: { ...IDEAL_SHEET } }, [
      {
        command: 'add_motion_profile',
        params: { id: 'hold', quantity: 'torque', unit: 'N*m', start: 0.05, segments: [{ kind: 'dwell', duration: 0.2 }] },
      },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 'hold' } },
    ]);
    const data = dataOf(execute(bare, 'size_drive', { motor: 'm' }));
    expect(data.notEvaluated.join(' ')).toMatch(/thermal.*no thermal data/);
    expect(data.notEvaluated.join(' ')).toMatch(/rms_current.*no nominal current/);
    expect(data.notEvaluated.join(' ')).toMatch(/speed.*no maximum speed/);
    expect(data.margins['thermal']).toBeUndefined();
    expect(data.thermal).toBeNull();
  });

  it('a voltage-limited command is reported (DRV_VOLTAGE_LIMITED) with the clipped sample count', () => {
    const doc = inertiaBench(1e-3, { sheet }, [
      {
        command: 'add_motion_profile',
        params: { id: 'hold', quantity: 'torque', unit: 'N*m', start: 0.0603 * 40, segments: [{ kind: 'dwell', duration: 0.05 }] },
      },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 'hold', currentLimitA: 10 } },
    ]);
    const data = dataOf(execute(doc, 'size_drive', { motor: 'm' }));
    expect(data.demand.limitedSamples).toBeGreaterThan(0);
    expect(codes(data)).toContain('DRV_VOLTAGE_LIMITED');
  });
});

describe('size_drive refusals (stable codes)', () => {
  const errorOf = (result: ReturnType<typeof execute>): { code: string; remediation: string } =>
    (result as unknown as { error: { code: string; remediation: string } }).error;
  const unchanged = (result: ReturnType<typeof execute>, doc: CadDocument): void => {
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  };

  it('unknown motor, a speed motor and no dynamics are no-ops with the reason', () => {
    const doc = servoSizingDoc();
    const unknown = execute(doc, 'size_drive', { motor: 'ghost' });
    expect(unknown.summary).toMatch(/no motor 'ghost'/);
    unchanged(unknown, doc);
    const speedDoc = runSteps([
      { command: 'add_cylinder', params: { radius: 5, height: 5, position: [0, 0, 0], axis: [0, 0, 1] }, as: 'g' },
      { command: 'add_rigid_body', params: { entityIds: ['$g'], id: 'b', massKg: 1 } },
      {
        command: 'add_body_joint',
        params: { kind: 'revolute', child: 'b', parent: 'ground', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'j' },
      },
      { command: 'add_motor', params: { joint: 'j', kind: 'speed', id: 's', rpm: 100, maxTorque: 1, source: { name: 'x', grade: 'B' } } },
    ]).doc;
    const speed = execute(speedDoc, 'size_drive', { motor: 's' });
    expect(speed.summary).toMatch(/speed motor: size_drive needs a datasheet motor/);
    unchanged(speed, speedDoc);
  });

  it('DRV_NO_DUTY_CYCLE: no drive, or a profile-less drive without `duration`', () => {
    const open = inertiaBench(1e-3);
    const noDrive = execute(open, 'size_drive', { motor: 'm' });
    expect(errorOf(noDrive).code).toBe('DRV_NO_DUTY_CYCLE');
    expect(errorOf(noDrive).remediation).toMatch(/set_motor_drive/);
    unchanged(noDrive, open);
    const constant = inertiaBench(1e-3, {}, [{ command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 5 } }]);
    const noWindow = execute(constant, 'size_drive', { motor: 'm' });
    expect(errorOf(noWindow).code).toBe('DRV_NO_DUTY_CYCLE');
    expect(noWindow.summary).toMatch(/no profile/);
    const withDuration = execute(constant, 'size_drive', { motor: 'm', duration: 0.05 });
    expect(withDuration.rejected).toBeUndefined();
    expect(dataOf(withDuration).window).toMatchObject({ seconds: 0.05, basis: 'requested duration' });
  });

  it('DRV_SOURCE_FAILED quotes the refusal of the simulation (controller step the sample rate cannot divide)', () => {
    const doc = servoSizingDoc();
    const refused = execute(doc, 'size_drive', { motor: 'm_re40', duration: 0.1, timestep: 3e-4 });
    expect(errorOf(refused).code).toBe('DRV_SOURCE_FAILED');
    expect(refused.summary).toMatch(/the simulation did not run: .*DRV_CONTROL_RATE/);
    unchanged(refused, doc);
  });

  it('DRV_SWEEP_NO_GEAR: a ratio sweep needs a gear driven by the motor joint', () => {
    const doc = inertiaBench(1e-3, { sheet: { ...IDEAL_SHEET } }, [
      {
        command: 'add_motion_profile',
        params: { id: 'hold', quantity: 'torque', unit: 'N*m', start: 0.01, segments: [{ kind: 'dwell', duration: 0.1 }] },
      },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 'hold' } },
    ]);
    const refused = execute(doc, 'size_drive', { motor: 'm', ratioSweep: [2, 4] });
    expect(errorOf(refused).code).toBe('DRV_SWEEP_NO_GEAR');
    expect(errorOf(refused).remediation).toMatch(/add_transmission/);
  });

  it('rejects invalid params through the schema (empty sweep, non-positive margin range)', () => {
    const doc = servoSizingDoc();
    expect(execute(doc, 'size_drive', { motor: 'm_re40', ratioSweep: [] }).summary).toMatch(/rejected: invalid params/);
    expect(execute(doc, 'size_drive', { motor: 'm_re40', ratioSweep: [0] }).summary).toMatch(/rejected: invalid params/);
    expect(execute(doc, 'size_drive', { motor: 'm_re40', margin: -1 }).summary).toMatch(/rejected: invalid params/);
  });
});
