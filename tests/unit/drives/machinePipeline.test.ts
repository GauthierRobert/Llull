/** DRV-M4 through size_drive (thermal, margins), check_motion_truth (provenance), plot_simulation (torque-speed limit curves), reference series and the report data. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { dataOf, simulate } from './fixtures';
import { INDUCTION_SHEET, MACHINE_SOURCE, PMSM_SHEET, STEPPER_SHEET, THERMAL, constantProfile, machineBench } from './machineFixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

interface Sized {
  demand: { peakCurrentA: number; rmsCurrentA: number; peakShaftTorqueNm: number; peakSpeedRpm: number };
  capacity: { peakCurrentA: { value: number; basis: string } | null; continuousCurrentA: { value: number } | null };
  margins: Record<string, number>;
  limiting: { factor: string } | null;
  thermal: { steadyAtRmsC: number | null; runaway: boolean } | null;
  findings: { code: string; status: string; ids: string[] }[];
  notEvaluated: string[];
  verdict: string;
  provenance: { lowest: { id: string; grade: string } | null };
}
const sizedOf = (result: ReturnType<typeof execute>): Sized => result.data as Sized;
const relative = (value: number, expected: number): number => Math.abs(value / expected - 1);

/** Steady winding temperature at a sustained current I with copper power r25 I^2 (hand formula of TR-DRV-09: T = (Ta + k (1 - 25 a)) / (1 - k a), k = (Rth1 + Rth2) r25 I^2). */
const steadyC = (r25: number, current: number): number => {
  const [alpha, k] = [0.0039, (1.9 + 4.7) * r25 * current * current];
  return (25 + k * (1 - 25 * alpha)) / (1 - k * alpha);
};

describe('size_drive on the machine kinds', () => {
  it('pmsm: a 0.5 N m load needs 0.5 / (1.5 p lambda) = 8.333 A (peak = RMS), the winding settles at the hand value, the margins follow the sheet', () => {
    const doc = machineBench(
      1e-3,
      { kind: 'pmsm', pmsmDatasheet: { ...PMSM_SHEET, nominalCurrentA: 9, maxSpeedRpm: 5000, thermal: THERMAL } },
      [
        constantProfile('t', 'torque', 'N*m', 0.5, 0.4),
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
      ],
    );
    const sized = sizedOf(execute(doc, 'size_drive', { motor: 'm' }));
    expect(sized.demand.peakCurrentA).toBeCloseTo(0.5 / 0.06, 9);
    // the recorded series starts at zero (the slot values are the outputs of the step that ended at a sample): the trapezoid RMS is within 0.5 % of the constant
    expect(relative(sized.demand.rmsCurrentA, 0.5 / 0.06)).toBeLessThan(0.005);
    expect(sized.demand.peakShaftTorqueNm).toBeCloseTo(0.5, 9);
    expect(sized.capacity.peakCurrentA).toMatchObject({ value: 20, basis: 'datasheet peak phase-current amplitude' });
    expect(sized.margins['peak_current']).toBeCloseTo(20 / (0.5 / 0.06) - 1, 9);
    expect(sized.margins['rms_current']).toBeCloseTo(9 / sized.demand.rmsCurrentA - 1, 9);
    // effective copper resistance 1.5 R = 0.075 ohm at the phase amplitude
    expect(sized.thermal?.steadyAtRmsC).toBeCloseTo(steadyC(0.075, sized.demand.rmsCurrentA), 6);
    expect(sized.limiting?.factor).toBe('rms_current');
    expect(sized.findings.map((f) => f.code)).toContain('DRV_MARGIN_LOW');
    expect(sized.verdict).toBe('marginal');
  });

  it('pmsm: the demand beyond the envelope is flagged DRV_VOLTAGE_LIMITED (the bus cannot give the torque asked)', () => {
    const doc = machineBench(1e-3, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET }, [
      constantProfile('t', 'torque', 'N*m', 3, 0.3),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
    const sized = sizedOf(execute(doc, 'size_drive', { motor: 'm' }));
    expect(sized.findings.map((f) => f.code)).toContain('DRV_VOLTAGE_LIMITED');
    expect(sized.demand.peakShaftTorqueNm).toBeCloseTo(1.2, 9);
    expect(sized.notEvaluated.join(' ')).toContain('thermal');
  });

  it('stepper: the chopper holds the rated current, so peak = RMS = 2 A and the margin against the rated current is zero (DRV_MARGIN_LOW); halving the setpoint doubles it', () => {
    const make = (limit: number | undefined): Sized => {
      const doc = machineBench(1e-3, { kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, thermal: THERMAL } }, [
        {
          command: 'add_motion_profile',
          params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 0.2 }] },
        },
        {
          command: 'set_motor_drive',
          params: { motor: 'm', mode: 'position', profile: 'p', ...(limit === undefined ? {} : { currentLimitA: limit }) },
        },
      ]);
      return sizedOf(execute(doc, 'size_drive', { motor: 'm', timestep: 1e-4 }));
    };
    const rated = make(undefined);
    expect(rated.demand.peakCurrentA).toBe(2);
    expect(relative(rated.demand.rmsCurrentA, 2)).toBeLessThan(0.005);
    expect(rated.margins['peak_current']).toBeCloseTo(0, 12);
    expect(rated.findings.map((f) => f.code)).toContain('DRV_MARGIN_LOW');
    // two phases heat: 2 R = 3 ohm effective
    expect(rated.thermal?.steadyAtRmsC).toBeCloseTo(steadyC(3, rated.demand.rmsCurrentA), 6);
    const half = make(1);
    expect(half.margins['peak_current']).toBeCloseTo(1, 12);
    expect(half.thermal?.steadyAtRmsC).toBeCloseTo(steadyC(3, half.demand.rmsCurrentA), 6);
  });

  it('induction: the direct-on-line start draws I2 = V / |R1 + R2 + jX| = 230 / sqrt(0.9^2 + 2^2) = 104.9 A, the sheet without a peak current lists it as not evaluated', () => {
    const doc = machineBench(1, { kind: 'induction', inductionDatasheet: { ...INDUCTION_SHEET, nominalCurrentA: 20 } }, [
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 230, frequencyHz: 50 } },
    ]);
    const sized = sizedOf(execute(doc, 'size_drive', { motor: 'm', duration: 2, sampleRate: 500 }));
    expect(relative(sized.demand.peakCurrentA, 230 / Math.hypot(0.9, 2))).toBeLessThan(0.005);
    expect(sized.capacity.peakCurrentA).toBeNull();
    expect(sized.notEvaluated.join(' ')).toContain('peak_current');
    expect(sized.findings.map((f) => f.code)).toContain('DRV_RMS_OVER');
    expect(sized.verdict).toBe('over');
  });

  it('a motor that is not a datasheet motor is refused, naming the kinds', () => {
    const doc = machineBench(1e-3, { kind: 'torque_curve', torque: 1 });
    const result = execute(doc, 'size_drive', { motor: 'm' });
    expect(result.summary).toContain('"pmsm", "stepper" or "induction"');
    expect(result.document).toBe(doc);
  });
});

interface TruthData {
  verdict: string;
  provenance: { id: string; grade: string }[];
  items: { code: string; status: string; ids: string[] }[];
}

describe('check_motion_truth provenance of the machine kinds', () => {
  const truthDoc = (grade: 'A' | 'C'): CadDocument =>
    machineBench(1e-3, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET, source: { ...MACHINE_SOURCE, grade } }, [
      constantProfile('t', 'torque', 'N*m', 0.3, 0.2),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
  const truth = (doc: CadDocument): TruthData => execute(doc, 'check_motion_truth', { duration: 0.2, level: 'quick' }).data as TruthData;

  it('the motor datasheet is a graded input: grade C makes the verdict plausible and DRV_PARAM_UNSOURCED names it, grade A leaves it trusted', () => {
    const weak = truth(truthDoc('C'));
    expect(weak.provenance[0]).toMatchObject({ id: 'm.datasheet', grade: 'C' });
    expect(weak.verdict).toBe('plausible');
    expect(weak.items.find((item) => item.code === 'DRV_PARAM_UNSOURCED')).toMatchObject({ status: 'warn', ids: ['m.datasheet'] });
    const strong = truth(truthDoc('A'));
    expect(strong.provenance[0]).toMatchObject({ id: 'm.datasheet', grade: 'A' });
    expect(strong.items.find((item) => item.code === 'DRV_PARAM_UNSOURCED')?.status).toBe('pass');
    expect(strong.items.find((item) => item.code === 'DRV_LEDGER_CLOSURE')?.status).toBe('pass');
  });

  it('an inconsistent sheet accepted with a reason is grade C and unverified, whatever its source says', () => {
    const doc = machineBench(
      1e-3,
      { kind: 'pmsm', pmsmDatasheet: { ...PMSM_SHEET, torqueConstantNmPerA: 0.09 }, acceptInconsistent: 'catalogue misprint' },
      [
        constantProfile('t', 'torque', 'N*m', 0.3, 0.2),
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
      ],
    );
    const result = truth(doc);
    expect(result.provenance[0]).toMatchObject({ id: 'm.datasheet', grade: 'C' });
    expect(result.verdict).toBe('plausible');
  });
});

describe('plot_simulation operating points with the limit curve of each kind', () => {
  const plot = (
    motor: Record<string, unknown>,
    drive: Record<string, unknown>,
    profile: ReturnType<typeof constantProfile>,
    params: Record<string, unknown>,
  ): string => {
    const doc = machineBench(1e-3, motor, [profile, { command: 'set_motor_drive', params: { motor: 'm', ...drive } }]);
    const result = execute(doc, 'plot_simulation', {
      quantities: ['operating_points', 'motor_current', 'motor_voltage', 'winding_temperature'],
      ...params,
    });
    return (result.data as { svg: string }).svg;
  };

  it('pmsm draws the torque envelope, stepper the pull-out torque, induction the torque-speed curve; each with the run points', () => {
    const pmsm = plot(
      { kind: 'pmsm', pmsmDatasheet: { ...PMSM_SHEET, thermal: THERMAL } },
      { mode: 'torque', profile: 't' },
      constantProfile('t', 'torque', 'N*m', 0.5, 1),
      { duration: 0.1 },
    );
    expect(pmsm).toContain('m torque envelope (peak current, bus)');
    expect(pmsm).toContain('m operating points');
    expect(pmsm).toContain('Winding temperature');
    const stepper = plot(
      { kind: 'stepper', stepperDatasheet: STEPPER_SHEET },
      { mode: 'velocity', profile: 'w' },
      constantProfile('w', 'velocity', 'rad/s', 1, 1),
      { duration: 0.05, timestep: 1e-4 },
    );
    expect(stepper).toContain('m pull-out torque');
    const induction = plot(
      { kind: 'induction', inductionDatasheet: INDUCTION_SHEET },
      { mode: 'frequency', profile: 'f' },
      constantProfile('f', 'frequency', 'Hz', 50, 1),
      { duration: 0.2, timestep: 1e-3 },
    );
    expect(induction).toContain('m torque at rated V, f');
  });
});

describe('reference series and the run data of the machine kinds', () => {
  it('a reference series can target a pmsm motor (motor_current), a missing motor is still refused', () => {
    const doc = machineBench(1e-3, { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET });
    const ok = execute(doc, 'add_reference_data', {
      series: { quantity: 'motor_current', target: 'm', times: [0, 0.1, 0.2], values: [0, 8, 8] },
      source: 'bench log',
      grade: 'B',
    });
    expect(ok.affected.length).toBe(1);
    const missing = execute(doc, 'add_reference_data', {
      series: { quantity: 'motor_current', target: 'ghost', times: [0, 0.1], values: [0, 8] },
      source: 'bench log',
    });
    expect(missing.document).toBe(doc);
    expect(missing.summary).toContain("no datasheet motor 'ghost'");
  });

  it('PMSM at 24 V bus with the real winding resistance: the stator voltage exceeds V_bus/sqrt(3) by the R i drop and the run says so (DRV_PMSM_VOLTAGE_OVER)', () => {
    const doc = machineBench(1e-3, { kind: 'pmsm', pmsmDatasheet: { ...PMSM_SHEET, phaseResistanceOhm: 0.2 } }, [
      constantProfile('t', 'torque', 'N*m', 1.2, 1),
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 't' } },
    ]);
    const data = dataOf(simulate(doc, { duration: 0.5, sampleRate: 1000, timestep: 1e-4, detail: 'drives', energy: true })) as unknown as {
      warnings: string[];
    };
    expect(data.warnings.some((w) => w.startsWith('DRV_PMSM_VOLTAGE_OVER'))).toBe(true);
  });

  it('a stepper run at the default 1 ms step warns that the explicit step is too coarse for its ringing (DRV_STEPPER_TIMESTEP)', () => {
    const doc = machineBench(1e-3, { kind: 'stepper', stepperDatasheet: STEPPER_SHEET }, [
      { command: 'add_motion_profile', params: { id: 'p', quantity: 'position', unit: 'deg', segments: [{ kind: 'dwell', duration: 1 }] } },
      { command: 'set_motor_drive', params: { motor: 'm', mode: 'position', profile: 'p' } },
    ]);
    const coarse = dataOf(simulate(doc, { duration: 0.01, detail: 'drives' })) as unknown as { warnings: string[] };
    expect(coarse.warnings.some((w) => w.startsWith('DRV_STEPPER_TIMESTEP'))).toBe(true);
    const fine = dataOf(simulate(doc, { duration: 0.01, timestep: 1e-5, detail: 'drives' })) as unknown as { warnings: string[] };
    expect(fine.warnings.some((w) => w.startsWith('DRV_STEPPER_TIMESTEP'))).toBe(false);
  });
});
