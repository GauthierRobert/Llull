/** Drive controllers through MuJoCo: VC-DRV-23 (tuned velocity PI), VC-DRV-24 (prescribed motion), anti-windup, limits, control-rate guards. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { IDEAL_SHEET, MAXON_SOURCE, RPM, at, dataOf, expectedResults, inertiaBench, section, simulate } from './fixtures';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

interface PiLoop {
  samples: { tS: number; response: number }[];
  peakResponse: number;
}

const step = (command: string, params: Record<string, unknown>): { command: string; params: Record<string, unknown> } => ({
  command,
  params,
});

describe('velocity PI tuned from a bandwidth (VC-DRV-23)', () => {
  const wc = 100;
  const doc = (): ReturnType<typeof inertiaBench> =>
    inertiaBench(1e-3, {}, [
      step('add_motion_profile', { id: 'w', quantity: 'velocity', unit: 'rad/s', start: 1, segments: [{ kind: 'dwell', duration: 0.2 }] }),
      step('set_motor_drive', {
        motor: 'm',
        mode: 'velocity',
        profile: 'w',
        tune: { bandwidthHz: wc / (2 * Math.PI), dampingRatio: 1 },
        sampleHz: 10000,
      }),
    ]);

  it('the unit step response follows 1 - e^(-wt) + wt e^(-wt): 0.6967 / 1.0 / 1.1353 / 1.0270 at 5 / 10 / 20 / 50 ms (0.01 abs)', () => {
    const data = dataOf(simulate(doc(), { duration: 0.06, timestep: 0.0001, sampleRate: 10000, detail: 'drives' }));
    const series = data.drives['m'].series;
    for (const row of section<PiLoop>('piSpeedLoop').samples) {
      const k = series.times.findIndex((t) => Math.abs(t - row.tS) < 1e-9);
      expect(Math.abs(at(series.shaftSpeedRpm, k) / RPM - row.response), `t = ${row.tS}`).toBeLessThan(0.01);
    }
    const peak = Math.max(...series.shaftSpeedRpm) / RPM;
    expect(Math.abs(peak - section<PiLoop>('piSpeedLoop').peakResponse)).toBeLessThan(0.01);
    expect(expectedResults.cases.filter((entry) => entry.id === 'VC-DRV-23')).toHaveLength(4);
  });

  it('refuses the run when the sample rate is not a whole number of steps (DRV_CONTROL_RATE) and runs at k = 2', () => {
    const refused = simulate(doc(), { duration: 0.01, timestep: 0.00007 });
    expect(refused.data).toBeUndefined();
    expect(refused.summary).toContain('DRV_CONTROL_RATE');
    const slower = dataOf(simulate(doc(), { duration: 0.06, timestep: 0.00005, sampleRate: 10000, detail: 'drives' }));
    expect(Math.abs(at(slower.drives['m'].series.shaftSpeedRpm, 200) / RPM - 1.1353)).toBeLessThan(0.02);
  });
});

describe('position loop and feedforward', () => {
  it('a position S-curve with feedforward is followed within 0.1 % of the move and ends on target', () => {
    const doc = inertiaBench(1e-3, {}, [
      step('add_motion_profile', {
        id: 'q',
        quantity: 'position',
        unit: 'deg',
        segments: [
          { kind: 'move', law: 's_curve', to: 90, duration: 0.4 },
          { kind: 'dwell', duration: 0.1 },
        ],
      }),
      step('set_motor_drive', {
        motor: 'm',
        mode: 'position',
        profile: 'q',
        tune: { bandwidthHz: 20, dampingRatio: 1 },
        sampleHz: 5000,
        feedforward: true,
      }),
    ]);
    const data = dataOf(simulate(doc, { duration: 0.5, timestep: 0.0002, sampleRate: 1000, detail: 'drives' }));
    expect(data.drives['m'].tracking.peakError).toBeLessThan(0.001 * (Math.PI / 2));
    expect(data.joints['j']?.finalPosition).toBeCloseTo(Math.PI / 2, 3);
    expect(data.warnings.join(' ')).not.toContain('TRACKING');
  });

  it('explicit gains work like tuned ones (kp 0.2, ki 10 on J = 1e-3)', () => {
    const doc = inertiaBench(1e-3, {}, [
      step('add_motion_profile', { id: 'w', quantity: 'velocity', unit: 'rad/s', start: 1, segments: [{ kind: 'dwell', duration: 0.2 }] }),
      step('set_motor_drive', { motor: 'm', mode: 'velocity', profile: 'w', gains: { kp: 0.2, ki: 10 }, sampleHz: 10000 }),
    ]);
    const data = dataOf(simulate(doc, { duration: 0.06, timestep: 0.0001, sampleRate: 10000, detail: 'drives' }));
    expect(Math.abs(at(data.drives['m'].series.shaftSpeedRpm, 200) / RPM - 1.1353)).toBeLessThan(0.01);
  });
});

describe('anti-windup and limits', () => {
  it('a saturated spin-up does not overshoot: the integrator stops while the current limit clips the command', () => {
    const doc = inertiaBench(1e-3, {}, [
      step('add_motion_profile', { id: 'w', quantity: 'velocity', unit: 'rad/s', start: 20, segments: [{ kind: 'dwell', duration: 2 }] }),
      step('set_motor_drive', {
        motor: 'm',
        mode: 'velocity',
        profile: 'w',
        tune: { bandwidthHz: 10, dampingRatio: 1 },
        sampleHz: 2000,
        currentLimitA: 0.3,
      }),
    ]);
    const data = dataOf(simulate(doc, { duration: 2, timestep: 0.0005, sampleRate: 500, detail: 'drives' }));
    const speeds = data.drives['m'].series.shaftSpeedRpm.map((rpm) => rpm / RPM);
    expect(Math.max(...speeds)).toBeLessThan(20 * 1.12);
    expect(speeds[speeds.length - 1]).toBeCloseTo(20, 0);
    expect(data.drives['m'].limitedSamples).toBeGreaterThan(100);
    expect(data.drives['m'].peak.currentA).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it('the bus voltage caps the current of a torque drive as the motor speeds up (R*i + ke*w <= bus)', () => {
    const doc = inertiaBench(1e-3, {}, [
      step('add_motion_profile', { id: 't', quantity: 'torque', unit: 'N*m', start: 2, segments: [{ kind: 'dwell', duration: 1 }] }),
      step('set_motor_drive', { motor: 'm', mode: 'torque', profile: 't', busVoltageV: 10 }),
    ]);
    const data = dataOf(simulate(doc, { duration: 0.3, timestep: 0.0001, sampleRate: 1000, detail: 'drives' }));
    const series = data.drives['m'].series;
    expect(data.drives['m'].peak.currentA).toBeLessThanOrEqual(10 / 1.13 + 1e-6);
    expect(Math.max(...series.voltageV)).toBeLessThanOrEqual(10 + 1e-6);
    expect(data.drives['m'].limitedSamples).toBeGreaterThan(0);
  });

  it('a voltage drive is clamped to the current limit and flags it', () => {
    const doc = inertiaBench(1e-3, { sheet: { ...IDEAL_SHEET, terminalInductanceH: 0.001 } }, [
      step('set_motor_drive', { motor: 'm', mode: 'voltage', volts: 48, currentLimitA: 5 }),
    ]);
    const data = dataOf(simulate(doc, { duration: 0.1, timestep: 0.0001, sampleRate: 1000, detail: 'drives' }));
    expect(data.drives['m'].peak.currentA).toBeLessThanOrEqual(5 + 1e-9);
    expect(data.drives['m'].limitedSamples).toBeGreaterThan(0);
  });
});

describe('prescribed motion (VC-DRV-24)', () => {
  const doc = (extra: Record<string, unknown> = {}): ReturnType<typeof inertiaBench> =>
    inertiaBench(1e-3, { sheet: IDEAL_SHEET }, [
      step('add_motion_profile', {
        id: 'q',
        quantity: 'position',
        unit: 'rad',
        segments: [{ kind: 'move', law: 's_curve', to: 1, vmax: 10, amax: 100, jerk: 10000 }],
      }),
      step('set_motor_drive', { motor: 'm', mode: 'prescribed', profile: 'q', ...extra }),
    ]);

  it('an S-curve with peak acceleration 100 rad/s^2 on J = 1e-3 needs a peak effort of 0.1 N*m and tracks within the threshold', () => {
    const data = dataOf(simulate(doc(), { duration: 0.5, timestep: 0.0001, sampleRate: 2000, detail: 'drives' }));
    expect(Math.abs(data.drives['m'].peak.jointTorqueNm / 0.1 - 1)).toBeLessThan(0.01);
    expect(data.drives['m'].tracking.peakError).toBeLessThan(0.01 * data.drives['m'].tracking.range);
    expect(data.warnings.join(' ')).not.toContain('DRV_TRACKING_ERROR');
    const pinned = expectedResults.cases.find((entry) => entry.id === 'VC-DRV-24');
    expect(pinned?.value).toBeCloseTo(0.1, 9);
  });

  it('an effort limit below the need warns DRV_TRACKING_ERROR: the effort is then not the inverse dynamics', () => {
    const data = dataOf(simulate(doc({ effortLimit: 0.03 }), { duration: 0.5, timestep: 0.0001, sampleRate: 2000, detail: 'drives' }));
    expect(data.warnings.join(' ')).toContain('DRV_TRACKING_ERROR');
    expect(data.drives['m'].peak.jointTorqueNm).toBeLessThanOrEqual(0.03 + 1e-12);
  });

  it('a velocity profile can be prescribed too', () => {
    const velocity = inertiaBench(1e-3, { sheet: IDEAL_SHEET }, [
      step('add_motion_profile', {
        id: 'w',
        quantity: 'velocity',
        unit: 'rad/s',
        segments: [
          { kind: 'move', law: 'cycloidal', to: 5, duration: 0.2 },
          { kind: 'dwell', duration: 0.1 },
        ],
      }),
      step('set_motor_drive', { motor: 'm', mode: 'prescribed', profile: 'w' }),
    ]);
    const data = dataOf(simulate(velocity, { duration: 0.3, timestep: 0.0001, sampleRate: 1000, detail: 'drives' }));
    expect(data.joints['j']?.finalVelocity).toBeCloseTo(5, 1);
    expect(data.drives['m'].tracking.unit).toBe('rad/s');
  });
});

describe('regeneration (VC-DRV-38 shape)', () => {
  it('dropping the supply below the back-EMF returns energy: negative electrical power, regenerated energy < 0, the ledger still closes', () => {
    const doc = inertiaBench(1e-4, { sheet: { ...IDEAL_SHEET, terminalInductanceH: 0.0003 } }, [
      step('add_motion_profile', {
        id: 'v',
        quantity: 'voltage',
        unit: 'V',
        start: 48,
        allowStep: true,
        segments: [
          { kind: 'dwell', duration: 0.05 },
          {
            kind: 'table',
            points: [
              [0, 12],
              [0.05, 12],
            ],
          },
        ],
      }),
      step('set_motor_drive', { motor: 'm', mode: 'voltage', profile: 'v' }),
    ]);
    const data = dataOf(simulate(doc, { duration: 0.1, timestep: 0.00005, sampleRate: 2000, detail: 'drives' }));
    const entry = (kind: string): number => data.ledger.entries.find((e) => e.kind === kind)?.joules ?? Number.NaN;
    expect(entry('regeneration')).toBeLessThan(0);
    expect(Math.min(...data.drives['m'].series.electricalPowerW)).toBeLessThan(0);
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
  });
});

describe('source line of the pack', () => {
  it('the maxon source grade and name are carried into the run data', () => {
    const doc = inertiaBench(1e-3, {}, [step('set_motor_drive', { motor: 'm', mode: 'voltage', volts: 1 })]);
    const data = dataOf(simulate(doc, { duration: 0.01, timestep: 0.0001 }));
    expect(data.drives['m'].sourceGrade).toBe(MAXON_SOURCE.grade);
  });
});
