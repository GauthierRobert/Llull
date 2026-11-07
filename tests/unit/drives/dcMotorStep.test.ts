/** VC-DRV-03 / 04 / 05 and the gearhead: the maxon RE 40 through the pack plan and MuJoCo, against the exact solutions of generate_drv_reference.py. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import {
  MAXON_SHEET,
  MAXON_SOURCE,
  RPM,
  at,
  dataOf,
  inertiaBench,
  loadPlan,
  rotorBench,
  runSteps,
  section,
  simulate,
  type DriveSeriesData,
} from './fixtures';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

interface Sample {
  tS: number;
  currentA: number;
  speedRadS: number;
}
const samples = section<{ samples: Sample[] }>('dcStep').samples;
const relative = (value: number, expected: number): number => Math.abs(value / expected - 1);

describe('drv_maxon_step plan (VC-DRV-04, 05)', () => {
  const plan = loadPlan('drv_maxon_step');
  let fine: ReturnType<typeof runSteps>;
  let data: ReturnType<typeof dataOf>;
  let series: DriveSeriesData;
  beforeAll(() => {
    // the same plan sampled every step so that 4.28 ms is on the grid
    fine = runSteps(
      plan.map((step) => (step.command === 'simulate_motion' ? { ...step, params: { ...step.params, sampleRate: 100000 } } : step)),
    );
    data = dataOf(fine.last);
    series = data.drives['m_re40'].series;
  });

  it('the plan runs: check_motor_data passes on its sheet and the motor reports as verified', () => {
    expect(data.drives['m_re40']).toMatchObject({ mode: 'voltage', joint: 'j_shaft', verified: true, sourceGrade: 'A' });
    expect(data.warnings).toEqual([]);
    const check = runSteps(plan.filter((step) => step.command !== 'simulate_motion')).last;
    expect((check.data as { consistent: boolean }).consistent).toBe(true);
  });

  it('speed and current follow the exact 2x2 solution within 0.5 % at every reference time', () => {
    for (const sample of samples) {
      const k = series.times.findIndex((t) => Math.abs(t - sample.tS) < 1e-9);
      expect(k, `t = ${sample.tS}`).toBeGreaterThan(0);
      expect(relative(at(series.shaftSpeedRpm, k) / RPM, sample.speedRadS), `speed at ${sample.tS}`).toBeLessThan(0.005);
      expect(relative(at(series.currentA, k), sample.currentA), `current at ${sample.tS}`).toBeLessThan(0.005);
    }
  });

  it('the current peaks at 36.83 A near 0.87 ms', () => {
    const currents = series.currentA;
    const peak = Math.max(...currents);
    const peakTime = at(series.times, currents.indexOf(peak));
    expect(relative(peak, 36.83)).toBeLessThan(0.005);
    expect(peakTime).toBeGreaterThan(0.0008);
    expect(peakTime).toBeLessThan(0.00092);
  });

  it('the ledger closes: input 8.6763 J = copper 4.3405 + kinetic 4.3358 + magnetic 1e-7 (0.5 % per term, closure 1e-3)', () => {
    const ledger = data.ledger;
    const entry = (kind: string): number => ledger.entries.find((e) => e.kind === kind)?.joules ?? Number.NaN;
    expect(relative(entry('electrical_input'), 8.6763)).toBeLessThan(0.005);
    expect(relative(entry('copper'), 4.34049)).toBeLessThan(0.005);
    expect(relative(entry('kinetic'), 4.33581)).toBeLessThan(0.005);
    expect(entry('magnetic')).toBeGreaterThan(0);
    expect(entry('magnetic')).toBeLessThan(1e-6);
    expect(entry('regeneration')).toBe(0);
    expect(ledger.closureRelative).toBeLessThan(1e-3);
    expect(ledger.closure).toBe('pass');
  });

  it('the summary run (no series) reports peaks and finals, and the document is untouched (read-only)', () => {
    const doc = fine.doc;
    const before = JSON.stringify(doc);
    const summary = simulate(doc, { duration: 0.03, timestep: 0.00001, sampleRate: 1000 });
    expect(JSON.stringify(doc)).toBe(before);
    expect(dataOf(summary).drives['m_re40'].series).toBeUndefined();
    expect(dataOf(summary).drives['m_re40'].final.shaftSpeedRpm / RPM).toBeCloseTo(795.59, 0);
    expect(dataOf(summary).ledger).toBeUndefined();
  });
});

describe('no-load speed with friction (VC-DRV-03)', () => {
  it('48 V on the 148877 sheet with I0 = 68.6 mA as Coulomb friction settles at 794.73 rad/s (7589.15 rpm)', () => {
    const doc = runSteps(
      [
        { command: 'add_motor', params: { joint: 'j_shaft', kind: 'dc', id: 'm', datasheet: MAXON_SHEET, source: MAXON_SOURCE } },
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 48 } },
      ],
      rotorBench(),
    ).doc;
    const data = dataOf(simulate(doc, { duration: 0.1, timestep: 0.0001, sampleRate: 1000, detail: 'drives' }));
    const final = data.drives['m'].final.shaftSpeedRpm;
    expect(relative(final / RPM, 794.734)).toBeLessThan(0.002);
    expect(relative(final, 7589.15)).toBeLessThan(0.002);
    expect(data.drives['m'].final.currentA).toBeCloseTo(0.0686, 3);
  });

  it('the no-load friction holds a motor at rest: no voltage, no drift', () => {
    const doc = runSteps(
      [
        { command: 'add_motor', params: { joint: 'j_shaft', kind: 'dc', id: 'm', datasheet: MAXON_SHEET, source: MAXON_SOURCE } },
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 0.001 } },
      ],
      rotorBench(),
    ).doc;
    const data = dataOf(simulate(doc, { duration: 0.05, timestep: 0.0001, detail: 'drives' }));
    expect(Math.abs(data.drives['m'].final.shaftSpeedRpm)).toBeLessThan(1e-3);
  });
});

describe('gearhead (VC-DRV-10 for a motor gearhead)', () => {
  it('0.1 N*m through N = 10, eta 0.9, J_in 1.37e-5, J_out 1.37e-3 accelerates the joint at 345.755 rad/s^2; the gear loss is 10 % of the shaft energy', () => {
    const doc = runSteps(
      [
        {
          command: 'add_motion_profile',
          params: { id: 'tau', quantity: 'torque', unit: 'N*m', start: 0.1, segments: [{ kind: 'dwell', duration: 1 }] },
        },
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'torque', profile: 'tau' } },
      ],
      inertiaBench(1.37e-3, {
        sheet: { ...MAXON_SHEET, noLoadCurrentA: 0, terminalInductanceH: 0 },
        gearhead: { ratio: 10, efficiency: 0.9 },
      }),
    ).doc;
    const data = dataOf(simulate(doc, { duration: 0.2, timestep: 0.0001, sampleRate: 500, detail: 'drives' }));
    const series = data.drives['m'].series;
    const k = series.times.findIndex((t) => Math.abs(t - 0.1) < 1e-9);
    const jointSpeed = at(series.shaftSpeedRpm, k) / RPM / 10;
    expect(relative(jointSpeed / 0.1, 345.755)).toBeLessThan(0.005);
    const entry = (kind: string): number => data.ledger.entries.find((e) => e.kind === kind)?.joules ?? Number.NaN;
    const shaftEnergy = entry('electrical_input') - entry('copper');
    expect(entry('transmission_loss') / shaftEnergy).toBeCloseTo(0.1, 6);
    expect(data.ledger.closureRelative).toBeLessThan(1e-3);
  });
});

describe('failure and information paths', () => {
  const driven = (extra: Record<string, unknown> = {}): ReturnType<typeof rotorBench> =>
    runSteps(
      [
        { command: 'add_motor', params: { joint: 'j_shaft', kind: 'dc', id: 'm', datasheet: MAXON_SHEET, source: MAXON_SOURCE, ...extra } },
        { command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 12 } },
      ],
      rotorBench(),
    ).doc;

  it('a motor without a drive is an open circuit: it adds its inertia but no torque and no drive data', () => {
    const doc = runSteps(
      [{ command: 'add_motor', params: { joint: 'j_shaft', kind: 'dc', id: 'm', datasheet: MAXON_SHEET, source: MAXON_SOURCE } }],
      rotorBench(),
    ).doc;
    const data = dataOf(simulate(doc, { duration: 0.01, timestep: 0.0001 }));
    expect(data.drives).toBeUndefined();
    expect(data.joints['j_shaft']?.finalVelocity).toBe(0);
  });

  it('an inconsistent sheet that was accepted is reported unverified', () => {
    const doc = driven({ datasheet: { ...MAXON_SHEET, torqueConstantNmPerA: 0.0663 }, acceptInconsistent: 'bench fit' });
    const data = dataOf(simulate(doc, { duration: 0.01, timestep: 0.0001 }));
    expect(data.drives['m'].verified).toBe(false);
    expect(data.warnings.join(' ')).toContain('unverified');
  });

  it('a negligible inductance is treated as quasi-static (DRV_ELECTRICAL_QUASI_STATIC), none at L = 0', () => {
    const quasi = dataOf(
      simulate(driven({ datasheet: { ...MAXON_SHEET, terminalInductanceH: 1e-7 } }), { duration: 0.01, timestep: 0.0001 }),
    );
    expect(quasi.warnings.join(' ')).toContain('DRV_ELECTRICAL_QUASI_STATIC');
    const none = dataOf(simulate(driven({ datasheet: { ...MAXON_SHEET, terminalInductanceH: 0 } }), { duration: 0.01, timestep: 0.0001 }));
    expect(none.warnings.join(' ')).not.toContain('QUASI');
    expect(none.drives['m'].final.currentA).toBeGreaterThan(0);
  });

  it('a profile that vanished from the document refuses the run with DRV_PROFILE_INVALID, nothing simulated', () => {
    const doc = driven();
    const dangling = {
      ...doc,
      dynamics: {
        ...(doc.dynamics as NonNullable<typeof doc.dynamics>),
        drives: { m: { id: 'm', mode: 'torque' as const, profile: 'ghost' } },
      },
    };
    const result = simulate(dangling, { duration: 0.01, timestep: 0.0001 });
    expect(result.data).toBeUndefined();
    expect(result.summary).toContain('DRV_PROFILE_INVALID');
    const noSource = {
      ...dangling,
      dynamics: { ...(dangling.dynamics as NonNullable<typeof doc.dynamics>), drives: { m: { id: 'm', mode: 'voltage' as const } } },
    };
    expect(simulate(noSource, { duration: 0.01, timestep: 0.0001 }).summary).toContain('needs volts or a profile');
    const lost = {
      ...dangling,
      dynamics: { ...(dangling.dynamics as NonNullable<typeof doc.dynamics>), drives: { m: { id: 'm', mode: 'velocity' as const } } },
    };
    expect(simulate(lost, { duration: 0.01, timestep: 0.0001 }).summary).toContain('needs a profile');
    const wrongTarget = {
      ...dangling,
      dynamics: {
        ...(dangling.dynamics as NonNullable<typeof doc.dynamics>),
        drives: { m: { id: 'm', mode: 'voltage' as const, volts: 1, target: 'ghost' } },
      },
    };
    expect(simulate(wrongTarget, { duration: 0.01, timestep: 0.0001 }).summary).toContain('DRV_JOINT_INVALID');
  });

  it('is deterministic: two runs give identical series', () => {
    const doc = driven();
    const a = dataOf(simulate(doc, { duration: 0.02, timestep: 0.0001, detail: 'drives' })).drives['m'].series;
    const b = dataOf(simulate(doc, { duration: 0.02, timestep: 0.0001, detail: 'drives' })).drives['m'].series;
    expect(b).toEqual(a);
  });

  it('keeps the legacy summary for a document without datasheet motors', () => {
    const doc = execute(rotorBench(), 'add_motor', { joint: 'j_shaft', kind: 'torque_curve', torque: 0.01 }).document;
    const data = dataOf(simulate(doc, { duration: 0.1, timestep: 0.001 }));
    expect(data.drives).toBeUndefined();
    expect(data.ledger).toBeUndefined();
  });
});
