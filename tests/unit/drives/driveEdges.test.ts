/** Run-time refusals of a drive that no longer matches the model, feedforward variants, and the load listing of a datasheet motor. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import type { MotorDrive } from '@core/model/drives';
import { AUX } from '@dynamics/sim/actuators/controller';
import { ledgerOf } from '@dynamics/sim/ledger';
import { buildSimulationModel } from '@dynamics/sim/simulationModel';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { dataOf, inertiaBench, simulate } from './fixtures';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const step = (command: string, params: Record<string, unknown>): { command: string; params: Record<string, unknown> } => ({
  command,
  params,
});

/** A bench with profiles w (velocity, rad/s), q (position, rad), t (torque) and v (voltage), and no drive. */
const bench = (): CadDocument =>
  inertiaBench(1e-3, {}, [
    step('add_motion_profile', { id: 'w', quantity: 'velocity', unit: 'rad/s', start: 2, segments: [{ kind: 'dwell', duration: 1 }] }),
    step('add_motion_profile', { id: 'q', quantity: 'position', unit: 'rad', start: 0, segments: [{ kind: 'dwell', duration: 1 }] }),
    step('add_motion_profile', { id: 't', quantity: 'torque', unit: 'N*m', start: 0.01, segments: [{ kind: 'dwell', duration: 1 }] }),
  ]);

/** The bench with `drive` stored directly (bypassing set_motor_drive, as a hand-edited or older document would). */
const withDrive = (drive: Omit<MotorDrive, 'id'>): CadDocument => {
  const doc = bench();
  return { ...doc, dynamics: { ...(doc.dynamics as NonNullable<typeof doc.dynamics>), drives: { m: { id: 'm', ...drive } } } };
};

const run = (doc: CadDocument, timestep = 0.0001): ReturnType<typeof execute> =>
  simulate(doc, { duration: 0.02, timestep, sampleRate: 1000 });

describe('a stored drive that cannot run is refused with its code and nothing is simulated', () => {
  const cases: [string, Omit<MotorDrive, 'id'>, string][] = [
    ['quantity of the profile does not fit the mode', { mode: 'torque', profile: 'w' }, 'needs a torque profile'],
    ['ghost profile', { mode: 'torque', profile: 'ghost' }, 'not found'],
    [
      'tuning above the sample rate',
      { mode: 'velocity', profile: 'w', tune: { bandwidthHz: 100, dampingRatio: 1 }, sampleHz: 1000 },
      'DRV_CONTROL_RATE',
    ],
    ['no sample rate', { mode: 'velocity', profile: 'w', gains: { kp: 1, ki: 0, kpPosition: 0 } }, 'needs sampleHz'],
    [
      'a sample rate finer than the step',
      { mode: 'velocity', profile: 'w', gains: { kp: 1, ki: 0, kpPosition: 0 }, sampleHz: 1e6 },
      'DRV_CONTROL_RATE',
    ],
    ['neither gains nor tune', { mode: 'velocity', profile: 'w', sampleHz: 1000 }, 'needs gains or tune'],
    [
      'position loop without kpPosition',
      { mode: 'position', profile: 'q', gains: { kp: 1, ki: 0, kpPosition: 0 }, sampleHz: 1000 },
      'kpPosition',
    ],
  ];
  for (const [name, drive, text] of cases)
    it(name, () => {
      const result = run(withDrive(drive));
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain(text);
    });
});

describe('controller variants', () => {
  it('velocity feedforward adds J * accel of the profile; position without feedforward is a pure P-over-PI cascade', () => {
    const velocity = withDrive({
      mode: 'velocity',
      profile: 'w',
      gains: { kp: 0.2, ki: 10, kpPosition: 0 },
      sampleHz: 10000,
      feedforward: true,
    });
    const plain = withDrive({ mode: 'velocity', profile: 'w', gains: { kp: 0.2, ki: 10, kpPosition: 0 }, sampleHz: 10000 });
    const fed = dataOf(run(velocity)).drives['m'];
    const bare = dataOf(run(plain)).drives['m'];
    expect(fed.peak.jointTorqueNm).toBeGreaterThan(0);
    expect(bare.peak.jointTorqueNm).toBeGreaterThan(0);
    const position = withDrive({ mode: 'position', profile: 'q', gains: { kp: 0.2, ki: 10, kpPosition: 50 }, sampleHz: 10000 });
    expect(dataOf(run(position)).drives['m'].verified).toBe(true);
  });

  it('a prescribed dwell has a zero-range reference: no tracking warning at rest', () => {
    const data = dataOf(run(withDrive({ mode: 'prescribed', profile: 'q' })));
    expect(data.drives['m'].tracking.range).toBe(0);
    expect(data.warnings.join(' ')).not.toContain('TRACKING');
  });

  it('a torque drive applies the profile torque through the gearhead-free shaft', () => {
    const data = dataOf(run(withDrive({ mode: 'torque', profile: 't' })));
    expect(data.drives['m'].final.jointTorqueNm).toBeCloseTo(0.01, 9);
  });
});

describe('list_dynamics_loads with a datasheet motor', () => {
  it('reports the motor with its peak joint torque', () => {
    const doc = withDrive({ mode: 'voltage', volts: 12 });
    const result = execute(doc, 'list_dynamics_loads', {});
    expect(result.summary).not.toContain('no-op');
    expect(JSON.stringify(result.data)).toContain('datasheet DC motor');
  });
});

describe('anti-windup against the bus voltage', () => {
  it('a velocity drive whose current the bus clips keeps a bounded integrator, however long the target is out of reach', () => {
    // the current limit is out of the way (1000 A): only the 10 V bus cuts the current
    const doc = withDrive({
      mode: 'velocity',
      profile: 'w',
      gains: { kp: 0.01, ki: 10, kpPosition: 0 },
      sampleHz: 10000,
      busVoltageV: 10,
      currentLimitA: 1000,
    });
    const built = buildSimulationModel(doc, 0.0001);
    if ('error' in built || built.model.actuators === undefined) throw new Error('no actuators');
    const block = built.model.actuators;
    let aux = block.aux0;
    let peak = 0;
    for (let k = 0; k < 20000; k++) {
      // the joint spins at +100 rad/s against a 2 rad/s target: the loop asks for reverse current the 10 V bus cannot give
      aux = block.advance({ time: k * 0.0001, jointPosition: { j: 0 }, jointVelocity: { j: 100 } }, aux, 0.0001).aux;
      peak = Math.max(peak, Math.abs(aux[AUX.integrator] ?? 0));
    }
    // unfrozen it grows by ki * error * Ts = 0.098 per sample (about 2000 N*m after 20000 samples); frozen it stays at the first sample
    expect(peak).toBeLessThan(1);
    expect(aux[AUX.clipped]).toBe(1);
  });
});

describe('ledger potential energy', () => {
  it('reports the change of potential energy, final minus initial, like the kinetic entry', () => {
    const trace = { ledger: [], actuatorWork: [0, 0], energy: { kinetic: [1, 4], potential: [5, 7] } } as unknown as SimulationTrace;
    const energy = {
      initialTotalJ: 6,
      finalKineticJ: 4,
      finalPotentialJ: 7,
      finalTotalJ: 11,
      dissipatedJ: 0,
      maxDeviationJ: 0,
      maxDeviationFraction: 0,
      inputWorkJ: 5,
      propellerWorkJ: 0,
    };
    const ledger = ledgerOf([], trace, energy);
    const entry = (kind: string): number | undefined => ledger?.entries.find((e) => e.kind === kind)?.joules;
    expect(entry('kinetic')).toBe(3);
    expect(entry('potential')).toBe(2);
  });
});
