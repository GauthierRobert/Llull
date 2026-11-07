/** One-sided end-stop restitution (VC-DRV-20 reference, DRV-M0 13.2.3), the actuator port in the MuJoCo adapter, DRV_EFFORT_UNBOUNDED (VC-DRV-33). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import {
  setPhysicsEngine,
  type ActuatorBlock,
  type PhysicsEngine,
  type SimulationBody,
  type SimulationModel,
} from '@core/dynamics/physicsEngine';
import { dampingRatioForRestitution, restitutionOfDamping } from '@dynamics/sim/endStop';
import { unboundedEffort } from '@dynamics/sim/driveReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { expectedResults, inertiaBench, rotorBench, section } from './fixtures';

let engine: PhysicsEngine;
beforeAll(async () => {
  engine = await createMujocoPhysics();
  setPhysicsEngine(engine);
});
afterAll(() => setPhysicsEngine(null));

describe('one-sided end stop (VC-DRV-20)', () => {
  it('zeta 0.2 gives 0.57174, not the bilateral 0.52662; it matches the pinned reference within the 3 % gate', () => {
    const stop = section<{ restitution: number; restitutionBilateral: number }>('endStop');
    expect(restitutionOfDamping(0.2)).toBeCloseTo(stop.restitution, 9);
    expect(stop.restitution).toBeCloseTo(0.57174, 5);
    expect(stop.restitutionBilateral).toBeCloseTo(Math.exp((-0.2 * Math.PI) / Math.sqrt(1 - 0.04)), 9);
    const pinned = expectedResults.cases.find((entry) => entry.id === 'VC-DRV-20');
    expect(pinned?.value).toBeCloseTo(0.57174, 5);
    expect(Math.abs(restitutionOfDamping(0.2) / (pinned?.value ?? 1) - 1)).toBeLessThan(0.03);
  });

  it('the curve is monotone from 1 (no damping) and its numeric inverse recovers the damping ratio', () => {
    expect(restitutionOfDamping(0)).toBeCloseTo(1, 12);
    let previous = 1;
    for (let zeta = 0.05; zeta < 0.99; zeta += 0.05) {
      const e = restitutionOfDamping(zeta);
      expect(e).toBeLessThan(previous);
      previous = e;
      expect(dampingRatioForRestitution(e)).toBeCloseTo(zeta, 8);
    }
    expect(dampingRatioForRestitution(0.5717)).toBeCloseTo(0.2, 3);
    expect(dampingRatioForRestitution(1)).toBeCloseTo(0, 6);
    expect(dampingRatioForRestitution(1.2)).toBeNull();
    expect(dampingRatioForRestitution(0.0001)).toBeNull();
  });
});

const hinge = (id: string, inertia: number): SimulationBody => ({
  id,
  parentId: null,
  mass: 1,
  centerOfMass: [0, 0, 0],
  inertia: [inertia / 2, inertia / 2, inertia, 0, 0, 0],
  fixed: false,
  joint: { id: `${id}-j`, kind: 'revolute', anchor: [0, 0, 0], axis: [0, 0, 1], damping: 0, friction: 0, initialVelocity: 0 },
});
const base = {
  gravity: [0, 0, 0] as [number, number, number],
  transmissions: [],
  loops: [],
  servos: [],
  solver: { integrator: 'rk4' as const, loopTimeConstant: 0.002, loopImpedance: 0.9999 },
};

describe('actuator port in the MuJoCo adapter', () => {
  // a constant torque 1 N*m counted in aux[0] (steps) with a ledger entry of the torque work estimate
  const block: ActuatorBlock = {
    size: 2,
    aux0: new Float64Array(2),
    joints: ['w-j'],
    ledgerLayout: [{ element: 'w', kind: 'electrical_input' }],
    advance: (state, aux, dt) => {
      const next = aux.slice();
      next[0] = (aux[0] ?? 0) + 1;
      next[1] = state.time;
      return {
        aux: next,
        jointForces: new Float64Array([1]),
        bodyForces: [],
        ledger: new Float64Array([1 * (state.jointVelocity['w-j'] ?? 0) * dt]),
      };
    },
  };

  it('applies the forces once per step, stores aux and the ledger per sample, and accounts the actuator work', () => {
    const model: SimulationModel = {
      ...base,
      bodies: [hinge('w', 0.5)],
      actuators: block,
      loads: () => ({ jointForces: {}, bodyForces: {} }),
    };
    const trace = engine.simulate(model, { duration: 1, timestep: 0.001, sampleInterval: 0.1, energy: true });
    expect(trace.aux?.[0]?.slice(0, 3)).toEqual([0, 100, 200]);
    expect(trace.aux?.[1]?.[1]).toBeCloseTo(0.0995, 9);
    expect(trace.jointVelocity['w-j']?.[10]).toBeCloseTo(2, 6);
    expect(trace.ledger?.[0]?.[10]).toBeCloseTo(1, 2);
    expect(trace.actuatorWork?.[10]).toBeCloseTo(1, 2);
    expect(trace.energy?.appliedWork?.[10]).toBeCloseTo(trace.actuatorWork?.[10] ?? Number.NaN, 12);
    expect(trace.ledger?.[0]?.[0]).toBe(0);
  });

  it('is deterministic and leaves the model without actuators untouched (no aux, no ledger)', () => {
    const plain: SimulationModel = { ...base, bodies: [hinge('w', 0.5)], loads: () => ({ jointForces: { 'w-j': 1 }, bodyForces: {} }) };
    const trace = engine.simulate(plain, { duration: 0.1, timestep: 0.001, sampleInterval: 0.1, energy: true });
    expect(trace.aux).toBeUndefined();
    expect(trace.ledger).toBeUndefined();
    expect(trace.actuatorWork).toBeUndefined();
    const model: SimulationModel = { ...plain, actuators: block, loads: () => ({ jointForces: {}, bodyForces: {} }) };
    const first = engine.simulate(model, { duration: 0.1, timestep: 0.001, sampleInterval: 0.01 });
    expect(engine.simulate(model, { duration: 0.1, timestep: 0.001, sampleInterval: 0.01 })).toEqual(first);
  });

  it('applies actuator body forces at the centre of mass and rejects an actuator on an unknown joint', () => {
    const pusher: ActuatorBlock = {
      ...block,
      joints: [],
      advance: (_state, aux) => ({
        aux,
        jointForces: new Float64Array(0),
        bodyForces: [
          { body: 'free', force: [3, 0, 0] },
          { body: 'ghost', force: [1, 0, 0] },
        ],
        ledger: new Float64Array(1),
      }),
    };
    const free: SimulationBody = {
      id: 'free',
      parentId: null,
      mass: 2,
      centerOfMass: [0, 0, 0],
      inertia: [1, 1, 1, 0, 0, 0],
      joint: null,
      fixed: false,
    };
    const trace = engine.simulate(
      { ...base, bodies: [free], actuators: pusher, loads: () => ({ jointForces: {}, bodyForces: {} }) },
      { duration: 1, timestep: 0.001, sampleInterval: 1 },
    );
    expect(trace.bodyPosition['free']?.[1]?.[0]).toBeCloseTo(0.75, 3);
    const lost: ActuatorBlock = { ...block, joints: ['nowhere'] };
    expect(() =>
      engine.simulate(
        { ...base, bodies: [hinge('w', 0.5)], actuators: lost, loads: () => ({ jointForces: {}, bodyForces: {} }) },
        { duration: 0.01, timestep: 0.001, sampleInterval: 0.01 },
      ),
    ).toThrow(/not a moving joint/);
  });

  it('an armature adds inertia to the joint coordinate: alpha = T / (J + armature)', () => {
    const body = hinge('w', 0.5);
    const armed: SimulationBody = { ...body, joint: body.joint === null ? null : { ...body.joint, armature: 0.5 } };
    const model: SimulationModel = { ...base, bodies: [armed], loads: () => ({ jointForces: { 'w-j': 1 }, bodyForces: {} }) };
    const trace = engine.simulate(model, { duration: 1, timestep: 0.001, sampleInterval: 1 });
    expect(trace.jointVelocity['w-j']?.[1]).toBeCloseTo(1, 6);
  });
});

describe('DRV_EFFORT_UNBOUNDED (TR-DRV-24, VC-DRV-33)', () => {
  const speedMotor = (extra: Record<string, unknown> = {}): ReturnType<typeof execute>['document'] =>
    execute(rotorBench(), 'add_motor', { joint: 'j_shaft', kind: 'speed', rpm: 60, maxTorque: 1e6, id: 'crank', ...extra }).document;
  const findings = (doc: ReturnType<typeof rotorBench>): { code: string; status: string; ids: string[] }[] =>
    (execute(doc, 'check_dynamics', { duration: 0.2 }).data as { items: { code: string; status: string; ids: string[] }[] }).items;

  it('a speed motor with a 1e6 N*m bound and no source is flagged by check_dynamics, the fix names a motor model or a sourced limit', () => {
    const result = execute(speedMotor(), 'check_dynamics', { duration: 0.2 });
    const item = (result.data as { items: { code: string; status: string; ids: string[]; remediation: string }[] }).items.find(
      (entry) => entry.code === 'DRV_EFFORT_UNBOUNDED',
    );
    expect(item?.status).toBe('warn');
    expect(item?.ids).toEqual(['crank']);
    expect(item?.remediation).toContain('motor model');
    expect(item?.remediation).toContain('sourced');
  });

  it('a sourced bound passes unless it is more than 10x what the run used; no other motor kind is flagged', () => {
    const loaded = (maxTorque: number): ReturnType<typeof rotorBench> =>
      execute(inertiaBench(0.01), 'add_motor', {
        joint: 'j',
        kind: 'speed',
        rpm: 60,
        maxTorque,
        id: 'crank',
        source: { name: 'gearmotor sheet', grade: 'B' },
      }).document;
    const run = execute(loaded(100), 'simulate_motion', { duration: 0.2, detail: 'series' }).data as {
      series: { motorTorque: Record<string, number[]> };
    };
    const used = Math.max(...(run.series.motorTorque['crank'] ?? []).map(Math.abs));
    expect(used).toBeGreaterThan(0.01);
    expect(findings(loaded(3 * used)).some((item) => item.code === 'DRV_EFFORT_UNBOUNDED')).toBe(false);
    expect(findings(loaded(100)).some((item) => item.code === 'DRV_EFFORT_UNBOUNDED')).toBe(true);
    const curve = execute(rotorBench(), 'add_motor', { joint: 'j_shaft', kind: 'torque_curve', torque: 1e-3 }).document;
    expect(findings(curve).some((item) => item.code === 'DRV_EFFORT_UNBOUNDED')).toBe(false);
  });

  it('the rule itself: unsourced, over 10x the peak used, or credible', () => {
    const motor = { id: 'm', kind: 'speed', joint: 'j', rpm: 1, maxTorque: 10 } as const;
    expect(unboundedEffort(motor, 9)).toContain('no motor model and no source');
    const sourced = { ...motor, source: { name: 's', grade: 'A' as const } };
    expect(unboundedEffort(sourced, 0.5)).toContain('more than 10x');
    expect(unboundedEffort(sourced, 5)).toBeNull();
    expect(unboundedEffort(sourced, null)).toBeNull();
    expect(unboundedEffort(sourced, 0)).toBeNull();
    expect(unboundedEffort({ id: 'c', kind: 'torque_curve', joint: 'j', curve: [[0, 1]], throttle: 1 }, 0)).toBeNull();
  });
});
