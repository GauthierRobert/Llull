/** DRV-M4 through the engine: PMSM torque and speed loop, stepper ringing / static deflection / lost steps, induction start and V/f, the ledger of each, against hand calculations. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import type { LedgerData } from '@dynamics/sim/ledger';
import { RPM, dataOf, seriesOf, simulate } from './fixtures';
import { INDUCTION_SHEET, PMSM_SHEET, STEPPER_SHEET, constantProfile, machineBench } from './machineFixtures';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const last = (values: readonly number[]): number => values[values.length - 1] ?? Number.NaN;
const relative = (value: number, expected: number): number => Math.abs(value / expected - 1);
const entryJ = (ledger: LedgerData, kind: string, element?: string): number =>
  ledger.entries.filter((e) => e.kind === kind && (element === undefined || e.element === element)).reduce((sum, e) => sum + e.joules, 0);

interface Run {
  drives: Record<
    string,
    {
      series: {
        times: number[];
        shaftSpeedRpm: number[];
        shaftTorqueNm: number[];
        currentA: number[];
        voltageV: number[];
        electricalPowerW: number[];
      };
    } & Record<string, unknown>
  >;
  ledger: LedgerData;
  warnings: string[];
}
const runOf = (
  doc: ReturnType<typeof machineBench>,
  params: Record<string, unknown>,
): { result: ReturnType<typeof simulate>; data: Run } => {
  const result = simulate(doc, { detail: 'drives', energy: true, ...params });
  return { result, data: dataOf(result) as unknown as Run };
};

describe('PMSM with field-oriented control (VC-DRV-25)', () => {
  const load = 1e-3;
  const torqueRun = (): ReturnType<typeof runOf> =>
    runOf(
      machineBench(load, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET }, [
        constantProfile('t', 'torque', 'N*m', 0.5, 1),
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
      ]),
      { duration: 0.2, sampleRate: 1000 },
    );

  it('a constant 0.5 N m below the base speed accelerates J = load + rotor at T / J (hand: 99.01 rad/s after 0.2 s), id = 0', () => {
    const { data } = torqueRun();
    const series = data.drives['m']?.series;
    expect(relative(last(series?.shaftSpeedRpm ?? []) / RPM, (0.5 * 0.2) / (load + 1e-5))).toBeLessThan(0.005);
    expect(relative(last(series?.shaftTorqueNm ?? []), 0.5)).toBeLessThan(1e-9);
    // iq = T / (1.5 p lambda) = 0.8333 A; with id = 0 the phase-current amplitude is iq
    expect(relative(last(series?.currentA ?? []), 0.5 / 0.06)).toBeLessThan(1e-9);
  });

  it('the ledger closes (< 1e-3): copper 1.5 R iq^2 t = 0.010417 J, the rest is kinetic energy 1/2 J w^2', () => {
    const { data } = torqueRun();
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
    expect(relative(entryJ(data.ledger, 'copper', 'm'), 1.5 * 0.05 * (0.5 / 0.06) ** 2 * 0.2)).toBeLessThan(2e-3);
    const speed = (0.5 * 0.2) / (load + 1e-5);
    expect(relative(entryJ(data.ledger, 'kinetic'), 0.5 * (load + 1e-5) * speed * speed)).toBeLessThan(0.01);
    expect(data.warnings.filter((w) => w.startsWith('DRV_'))).toEqual([]);
  });

  it('the torque command is cut at the envelope: 5 N m asked, 1.2 N m delivered (J acceleration 1.2 / J), flagged as limited', () => {
    const doc = machineBench(load, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET }, [
      constantProfile('t', 'torque', 'N*m', 5, 1),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
    const { data } = runOf(doc, { duration: 0.1, sampleRate: 1000 });
    const series = data.drives['m']?.series;
    expect(relative(last(series?.shaftTorqueNm ?? []), 1.2)).toBeLessThan(1e-9);
    expect(data.drives['m']).toMatchObject({ limitedSamples: expect.any(Number) });
    expect(Number(data.drives['m']?.['limitedSamples'])).toBeGreaterThan(50);
  });

  it('in field weakening the delivered torque follows the envelope (1.030 N m at 400 rad/s) and the bus voltage is the limit', () => {
    // the load starts at 400 rad/s: a dedicated joint speed through add_body_joint is not available, so the speed is reached by torque and read when it passes 400
    const doc = machineBench(1e-3, { kind: 'pmsm', pmsmDatasheet: { ...PMSM_SHEET, phaseResistanceOhm: 1e-6 } }, [
      constantProfile('t', 'torque', 'N*m', 1.2, 1),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
    const { data } = runOf(doc, { duration: 1, sampleRate: 5000, timestep: 1e-4 });
    const series = data.drives['m']?.series;
    const speeds = (series?.shaftSpeedRpm ?? []).map((v) => v / RPM);
    // the speed settles where the envelope torque falls to the friction-free zero: the maximum speed 577.350 rad/s
    expect(relative(Math.max(...speeds), 577.35)).toBeLessThan(0.01);
    const k = speeds.findIndex((w) => w >= 400);
    expect(k).toBeGreaterThan(0);
    expect(relative(series?.shaftTorqueNm[k] ?? Number.NaN, 1.03042)).toBeLessThan(0.02);
    expect(Math.max(...(series?.voltageV ?? []))).toBeLessThanOrEqual((24 / Math.sqrt(3)) * 1.001);
  });

  it('a velocity loop reaches 100 rad/s from rest: final speed within 1 %, torque saturates at the envelope on the way', () => {
    const doc = machineBench(load, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET }, [
      constantProfile('w', 'velocity', 'rad/s', 100, 1),
      {
        command: 'set_motor_drive',
        params: { motor: 'm', mode: 'velocity', profile: 'w', tune: { bandwidthHz: 20, dampingRatio: 1 }, sampleHz: 1000 },
      },
    ]);
    const { data } = runOf(doc, { duration: 0.5, sampleRate: 1000 });
    const series = data.drives['m']?.series;
    expect(relative(last(series?.shaftSpeedRpm ?? []) / RPM, 100)).toBeLessThan(0.01);
    expect(Math.max(...(series?.shaftTorqueNm ?? []))).toBeCloseTo(1.2, 6);
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
  });

  it('a gearhead 5:1 (eta 0.9): joint torque = N eta T, joint speed = motor speed / N, the gear loss is in the ledger and the ledger closes', () => {
    const doc = machineBench(load, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET, gearhead: { ratio: 5, efficiency: 0.9 } }, [
      constantProfile('t', 'torque', 'N*m', 0.2, 1),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
    const { result, data } = runOf(doc, { duration: 0.05, sampleRate: 1000 });
    // J at the joint = load + eta N^2 J_rotor; alpha = N eta T / J
    const jointInertia = load + 0.9 * 25 * 1e-5;
    const jointSpeed = last(seriesOf(result, 'jointVelocity', 'j'));
    expect(relative(jointSpeed, (5 * 0.9 * 0.2 * 0.05) / jointInertia)).toBeLessThan(0.005);
    expect(relative(last(data.drives['m']?.series.shaftSpeedRpm ?? []) / RPM, jointSpeed * 5)).toBeLessThan(1e-6);
    expect(entryJ(data.ledger, 'transmission_loss', 'm')).toBeGreaterThan(0);
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
  });
});

describe('stepper (VC-DRV-27)', () => {
  const degrees = (joint: number): number => (joint * 180) / Math.PI;
  const ringing = (): { times: number[]; positions: number[]; target: number } => {
    // 3 micro-steps of 1.8 / 64 degrees = 0.084375 degrees (a small-angle step: N_r theta = 4.2 degrees electrical), on a rotor-only bench
    const doc = machineBench(1e-9, { kind: 'stepper', stepperDatasheet: STEPPER_SHEET }, [
      {
        command: 'add_motion_profile',
        params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'move', law: 'linear', to: 0.0844, duration: 1e-4 }] },
      },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'position', profile: 'p', stepDivision: 64 } },
    ]);
    const result = simulate(doc, { duration: 0.03, sampleRate: 100000, timestep: 1e-5, detail: 'drives', energy: true });
    return {
      times: (dataOf(result) as unknown as { series: { times: number[] } }).series.times,
      positions: seriesOf(result, 'jointPosition', 'j'),
      target: (3 * (2 * Math.PI)) / 200 / 64,
    };
  };

  it('the undamped rotor rings at sqrt(T_h N_r / J) / 2 pi = 251.646 Hz (J = 1e-5 + 1e-9), within 2 %', () => {
    const { times, positions, target } = ringing();
    const up: number[] = [];
    for (let k = 1; k < positions.length; k++) {
      const [a, b] = [(positions[k - 1] ?? 0) - target, (positions[k] ?? 0) - target];
      if (times[k] !== undefined && (times[k] ?? 0) > 0.001 && a < 0 && b >= 0)
        up.push((times[k - 1] ?? 0) + ((times[k] ?? 0) - (times[k - 1] ?? 0)) * (-a / (b - a)));
    }
    expect(up.length).toBeGreaterThan(4);
    const period = ((up[up.length - 1] ?? 0) - (up[0] ?? 0)) / (up.length - 1);
    const expected = Math.sqrt((0.5 * 50) / (1e-5 + 1e-9)) / (2 * Math.PI);
    expect(relative(1 / period, expected)).toBeLessThan(0.02);
    expect(relative(1 / period, 251.646)).toBeLessThan(0.02);
  });

  it('half the holding torque as load deflects a damped rotor by 0.6 degrees (T = T_h sin(N_r theta)), within 1 %; no step is lost', () => {
    const doc = machineBench(1e-5, { kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, dampingNmsPerRad: 0.02 } }, [
      {
        command: 'add_motor',
        params: { joint: 'j', id: 'load_torque', kind: 'torque_curve', torque: -0.25, source: { name: 'test load', grade: 'A' } },
      },
      { command: 'add_motion_profile', params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 1 }] } },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'position', profile: 'p' } },
    ]);
    const result = simulate(doc, { duration: 0.2, sampleRate: 10000, timestep: 1e-4, detail: 'drives', energy: true });
    const deflection = degrees(last(seriesOf(result, 'jointPosition', 'j')));
    expect(relative(Math.abs(deflection), 0.6)).toBeLessThan(0.01);
    const data = dataOf(result) as unknown as Run;
    expect(data.drives['m']?.['stepper']).toMatchObject({ lostSteps: 0, firstLostS: null });
    expect(data.warnings.join(' ')).not.toContain('DRV_STEPS_LOST');
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
  });

  it('a load above the holding torque makes the rotor slip: DRV_STEPS_LOST with its time, a multiple of 4 full steps', () => {
    const doc = machineBench(1e-5, { kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, dampingNmsPerRad: 0.01 } }, [
      {
        command: 'add_motor',
        params: { joint: 'j', id: 'load_torque', kind: 'torque_curve', torque: -0.8, source: { name: 'test load', grade: 'A' } },
      },
      { command: 'add_motion_profile', params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 1 }] } },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'position', profile: 'p' } },
    ]);
    const result = simulate(doc, { duration: 0.2, sampleRate: 10000, timestep: 1e-4, detail: 'drives', energy: true });
    const data = dataOf(result) as unknown as Run;
    const stepper = data.drives['m']?.['stepper'] as { lostSteps: number; peakLostSteps: number; firstLostS: number };
    expect(Math.abs(stepper.lostSteps)).toBeGreaterThanOrEqual(4);
    expect(Math.abs(stepper.lostSteps) % 4).toBe(0);
    expect(stepper.firstLostS).toBeGreaterThan(0);
    expect(data.warnings.some((w) => w.startsWith('DRV_STEPS_LOST'))).toBe(true);
  });

  it('a velocity (step rate) profile above the pull-out speed loses steps; the same load at a low rate does not', () => {
    // 0.3 N m load: the L/R pull-out torque 0.5 / sqrt(1 + (N_r w tau)^2) falls below it above w = sqrt((0.5/0.3)^2 - 1) / (50 * 0.002) = 13.3 rad/s
    const make = (rate: number): ReturnType<typeof dataOf> => {
      const doc = machineBench(1e-5, { kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, dampingNmsPerRad: 0.02 } }, [
        {
          command: 'add_motor',
          params: { joint: 'j', id: 'load_torque', kind: 'torque_curve', torque: -0.3, source: { name: 'test load', grade: 'A' } },
        },
        constantProfile('w', 'velocity', 'rad/s', rate, 1),
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'velocity', profile: 'w' } },
      ]);
      return dataOf(simulate(doc, { duration: 0.5, sampleRate: 2000, timestep: 1e-4, detail: 'drives', energy: true }));
    };
    const slow = make(1) as unknown as Run;
    const fast = make(60) as unknown as Run;
    expect(slow.warnings.some((w) => w.startsWith('DRV_STEPS_LOST'))).toBe(false);
    expect(fast.warnings.some((w) => w.startsWith('DRV_STEPS_LOST'))).toBe(true);
  });

  it('the electrical input is copper 2 R I^2 plus the work of the field: the ledger closes at rest (no motion, only copper)', () => {
    const doc = machineBench(1e-3, { kind: 'stepper', stepperDatasheet: STEPPER_SHEET }, [
      { command: 'add_motion_profile', params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 1 }] } },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'position', profile: 'p' } },
    ]);
    const { data } = runOf(doc, { duration: 0.1, sampleRate: 1000 });
    expect(relative(entryJ(data.ledger, 'copper', 'm'), 2 * 1.5 * 4 * 0.1)).toBeLessThan(1e-9);
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
  });
});

describe('induction motor (VC-DRV-26)', () => {
  const load = 1.0;
  const dol = (): ReturnType<typeof runOf> =>
    runOf(
      machineBench(load, { kind: 'induction', inductionDatasheet: INDUCTION_SHEET }, [
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 230, frequencyHz: 50 } },
      ]),
      { duration: 2.5, sampleRate: 500 },
    );

  it('a direct-on-line start accelerates at the starting torque / J: 84.018 / 1.2 = 70.01 rad/s^2 (speed after 10 ms: 0.700 rad/s)', () => {
    const doc = machineBench(load, { kind: 'induction', inductionDatasheet: INDUCTION_SHEET }, [
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 230, frequencyHz: 50 } },
    ]);
    const result = simulate(doc, { duration: 0.02, sampleRate: 1000, timestep: 1e-4, detail: 'drives' });
    const times = (dataOf(result) as unknown as { series: { times: number[] } }).series.times;
    const speed = seriesOf(result, 'jointVelocity', 'j');
    const k = times.findIndex((t) => Math.abs(t - 0.01) < 1e-9);
    expect(relative(speed[k] ?? Number.NaN, (84.0179275 / 1.2) * 0.01)).toBeLessThan(0.01);
  });

  it('the motor runs up to synchronous speed 157.08 rad/s (no load, no friction: slip -> 0); the no-load start loses 1/2 J w_s^2 in the rotor', () => {
    const { data } = dol();
    const series = data.drives['m']?.series;
    const finalSpeed = last(series?.shaftSpeedRpm ?? []) / RPM;
    expect(relative(finalSpeed, 157.0796)).toBeLessThan(0.005);
    // textbook identity: starting without load, the rotor resistance dissipates exactly the kinetic energy gained (int s P_ag dt = int (w_s - w) J dw)
    const kinetic = 0.5 * (load + 0.2) * finalSpeed * finalSpeed;
    expect(relative(entryJ(data.ledger, 'rotor', 'm'), kinetic)).toBeLessThan(0.02);
  });

  it('the ledger closes (< 1e-3) with stator copper, rotor copper and iron loss, and the induction warning names the model form', () => {
    const doc = machineBench(load, { kind: 'induction', inductionDatasheet: { ...INDUCTION_SHEET, ironLossResistanceOhm: 800 } }, [
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 230, frequencyHz: 50 } },
    ]);
    const { data } = runOf(doc, { duration: 1.5, sampleRate: 500 });
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
    expect(entryJ(data.ledger, 'copper', 'm')).toBeGreaterThan(0);
    expect(relative(entryJ(data.ledger, 'iron', 'm'), ((3 * 230 * 230) / 800) * 1.5)).toBeLessThan(1e-6);
    expect(data.warnings.some((w) => w.startsWith('DRV_INDUCTION_QUASI_STEADY'))).toBe(true);
  });

  it('a V/f ramp 0 -> 50 Hz over 5 s: the rotor follows the field (final speed within 1 % of 157.08 rad/s), reversing the sign of the frequency reverses it', () => {
    const ramp = (to: number): number => {
      const doc = machineBench(load, { kind: 'induction', inductionDatasheet: INDUCTION_SHEET }, [
        {
          command: 'add_motion_profile',
          params: {
            id: 'f',
            quantity: 'frequency',
            unit: 'Hz',
            segments: [
              { kind: 'move', law: 'linear', to, duration: 5 },
              { kind: 'dwell', duration: 1 },
            ],
          },
        },
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'frequency', profile: 'f' } },
      ]);
      const { data } = runOf(doc, { duration: 6, sampleRate: 100, timestep: 2e-3 });
      return last(data.drives['m']?.series.shaftSpeedRpm ?? []) / RPM;
    };
    expect(relative(ramp(50), 157.0796)).toBeLessThan(0.01);
    expect(relative(ramp(-50), -157.0796)).toBeLessThan(0.01);
  });
});

describe('every kind through the same pipeline', () => {
  it('each kind is refused a mode it does not take, by name (DRV_MODE_UNSUPPORTED), and the document is returned unchanged', () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET },
        { motor: 'm', mode: 'voltage', volts: 5 },
      ],
      [
        { kind: 'stepper', stepperDatasheet: STEPPER_SHEET },
        { motor: 'm', mode: 'torque', profile: 'x' },
      ],
      [
        { kind: 'induction', inductionDatasheet: INDUCTION_SHEET },
        { motor: 'm', mode: 'torque', profile: 'x' },
      ],
    ];
    for (const [motor, drive] of cases) {
      const doc = machineBench(1e-3, motor);
      const result = execute(doc, 'set_motor_drive', drive);
      expect(result.summary).toContain('DRV_MODE_UNSUPPORTED');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
  });
});
