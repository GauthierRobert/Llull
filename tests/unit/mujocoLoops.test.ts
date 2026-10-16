/**
 * PHY-21 closed loops on MuJoCo: slider-crank kinematics (VC-FPR-10), static crank torque and rod / side forces (VC-FPR-11, 12), loop
 * residual (VC-FPR-13, 35), start-pose refusal (VC-FPR-21), reaction sign and frame conventions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { setPhysicsEngine, type PhysicsEngine, type SimulationBody, type SimulationModel } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { sliderCrank, travel } from './sliderCrankFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

type LoopData = SimulationData & {
  loops?: { residualM: number; tier: string; solver: { timestepS: number } };
  reactions?: {
    joints: Record<string, { forceN: { value: number; angleDeg: number | null } }>;
    loops: Record<string, { forceN: { value: number } }>;
  };
};

function simulate(doc: CadDocument, params: Record<string, unknown>): LoopData {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as LoopData;
}

function withMotor(doc: CadDocument, rpm: number): CadDocument {
  return execute(doc, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm, maxTorque: 1e5 }).document;
}

describe('slider-crank kinematics (VC-FPR-10)', () => {
  it('piston travel follows x(theta) to 1e-6 m at 2700 rpm (r 49.2125 mm, l 150 mm)', () => {
    const { doc, r, l } = sliderCrank({ wrist: 'spherical', crankRpm: 2700 });
    const data = simulate(withMotor(doc, 2700), { duration: 0.1, sampleRate: 20000, detail: 'poses' });
    const times = data.poses?.times ?? [];
    const crank = data.series?.jointPosition['crank_j'] ?? [];
    const piston = data.poses?.bodies['piston']?.position ?? [];
    const x0 = piston[0]?.[0] ?? 0;
    let worst = 0;
    times.forEach((_, i) => {
      const expected = travel(r, l, crank[i] ?? 0);
      const actual = (x0 - (piston[i]?.[0] ?? 0)) / 1000;
      worst = Math.max(worst, Math.abs(actual - expected));
    });
    expect(times.length).toBeGreaterThan(1500);
    expect(worst).toBeLessThan(1e-6);
    expect(data.loops?.tier).toBe('pass');
    expect(data.loops?.residualM ?? 1).toBeLessThan(1e-6);
    expect(data.loops?.solver.timestepS ?? 1).toBeCloseTo((0.5 * Math.PI) / 180 / ((2700 * 2 * Math.PI) / 60), 9);
  });
});

const solver = { integrator: 'rk4', loopTimeConstant: 0.0004, loopImpedance: 0.9999 } as const;
const noLoads = (): { jointForces: Record<string, number>; bodyForces: Record<string, [number, number, number]> } => ({
  jointForces: {},
  bodyForces: {},
});

function bob(center: [number, number, number], joint: SimulationBody['joint']): SimulationBody {
  return { id: 'bob', parentId: null, mass: 2, centerOfMass: center, inertia: [0.1, 0.1, 0.1, 0, 0, 0], fixed: false, joint };
}

describe('constraint forces and their signs (TR-FPR-07)', () => {
  let engine: PhysicsEngine;
  beforeAll(async () => {
    engine = await createMujocoPhysics();
  });

  it('a spherical loop to the world holds a hanging body: force on bodyB = +m g (up), residual below 1 µm', () => {
    const model: SimulationModel = {
      gravity: [0, 0, -9.81],
      bodies: [bob([1, 0, 0], null)],
      gears: [],
      loops: [{ id: 'pin', kind: 'spherical', bodyA: 'world', bodyB: 'bob', anchor: [1, 0, 0], axis: [0, 0, 1], halfSpan: 0.01 }],
      solver,
      servos: [],
      loads: noLoads,
    };
    const trace = engine.simulate(model, { duration: 0.2, timestep: 2e-5, sampleInterval: 0.05, reactions: true });
    const force = trace.loopForce?.['pin']?.at(-1) ?? [];
    expect(force[0]).toBeCloseTo(0, 3);
    expect(force[1]).toBeCloseTo(0, 3);
    expect(force[2]).toBeCloseTo(2 * 9.81, 2);
    expect(trace.loopResidual ?? 1).toBeLessThan(1e-6);
  });

  it('a revolute loop (two pins) carries the same weight and keeps the third rotation free', () => {
    const model: SimulationModel = {
      gravity: [0, 0, -9.81],
      bodies: [bob([1, 0, 0], null)],
      gears: [],
      loops: [{ id: 'hinge', kind: 'revolute', bodyA: 'world', bodyB: 'bob', anchor: [1, 0, 0], axis: [0, 1, 0], halfSpan: 0.05 }],
      solver,
      servos: [],
      loads: noLoads,
    };
    const trace = engine.simulate(model, { duration: 0.2, timestep: 2e-5, sampleInterval: 0.05, reactions: true });
    const force = trace.loopForce?.['hinge']?.at(-1) ?? [];
    expect(force[2]).toBeCloseTo(2 * 9.81, 2);
    expect(trace.loopResidual ?? 1).toBeLessThan(1e-6);
  });

  it('a tree hinge reports the force on its child at the anchor, world axes, and the moment about the anchor', () => {
    // COM 1 m to the side of the hinge, held horizontal by a joint torque that balances its weight
    const joint = {
      id: 'hinge',
      kind: 'revolute',
      anchor: [0, 0, 0],
      axis: [0, 1, 0],
      damping: 0,
      friction: 0,
      initialVelocity: 0,
    } as const;
    const model: SimulationModel = {
      gravity: [0, 0, -9.81],
      bodies: [bob([1, 0, 0], joint)],
      gears: [],
      loops: [],
      solver,
      servos: [],
      loads: () => ({ jointForces: { hinge: -2 * 9.81 }, bodyForces: {} }),
    };
    const trace = engine.simulate(model, { duration: 0.01, timestep: 1e-4, sampleInterval: 0.01, reactions: true });
    const reaction = trace.jointReaction?.['hinge'];
    const [force, moment] = [reaction?.force.at(-1) ?? [], reaction?.moment.at(-1) ?? []];
    expect(force[2]).toBeCloseTo(2 * 9.81, 3);
    expect(force[0]).toBeCloseTo(0, 3);
    // the parent holds the weight at the anchor and supplies -m g d about it
    expect(moment[1]).toBeCloseTo(-2 * 9.81, 3);
    expect(moment[0]).toBeCloseTo(0, 3);
    expect(moment[2]).toBeCloseTo(0, 3);
  });

  it('records no reactions unless asked', () => {
    const model: SimulationModel = {
      gravity: [0, 0, 0],
      bodies: [bob([0, 0, 0], null)],
      gears: [],
      loops: [],
      solver,
      servos: [],
      loads: noLoads,
    };
    const trace = engine.simulate(model, { duration: 0.01, timestep: 1e-3, sampleInterval: 0.01 });
    expect(trace.jointReaction).toBeUndefined();
    expect(trace.loopForce).toBeUndefined();
    expect(trace.loopResidual).toBeUndefined();
  });
});

describe('simulate_motion with loops', () => {
  it('refuses a loop open at the start pose (VC-FPR-21): FPR_LOOP_OPEN with the 1.000 mm gap, nothing run', () => {
    const { doc } = sliderCrank({ wristGapMm: 1 });
    const result = execute(withMotor(doc, 600), 'simulate_motion', { duration: 0.01 });
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/FPR_LOOP_OPEN.*wrist_j.*1.000 mm/);
    expect(result.error?.code).toBe('FPR_LOOP_OPEN');
    expect(result.error?.ids).toEqual(['wrist_j']);
  });

  it('refuses a body carried only by a spherical joint', () => {
    const { doc } = sliderCrank({ order: ['crank_j', 'rod_j', 'wrist_j'] });
    const result = execute(doc, 'simulate_motion', { duration: 0.01 });
    expect(result.summary).toMatch(/FPR_SPHERICAL_TREE/);
    expect(result.error?.code).toBe('FPR_SPHERICAL_TREE');
  });

  it('tiers the residual (VC-FPR-35): a loose solver drifts past the pass tier and says so', () => {
    const { doc } = sliderCrank({ crankRpm: 2700 });
    const loose = execute(withMotor(doc, 2700), 'set_dynamics_solver', { loopImpedance: 0.9, loopTimeConstantSteps: 50 });
    expect(loose.document.dynamics?.solver?.loopImpedance).toBe(0.9);
    const data = simulate(loose.document, { duration: 0.02, timestep: 1e-4 });
    expect(data.loops?.tier).not.toBe('pass');
    expect(data.warnings.some((w) => w.startsWith('FPR_LOOP_DRIFT'))).toBe(true);
  });

  it('reports peaks by default with the crank angle axis, and nothing for loop-free models', () => {
    const { doc } = sliderCrank({ crankRpm: 600, pistonKg: 0.4 });
    const data = simulate(withMotor(doc, 600), { duration: 0.1, crankAxis: 'crank_j' });
    expect(data.reactions?.joints['crank_j']?.forceN.value ?? 0).toBeGreaterThan(0);
    expect(data.reactions?.loops['wrist_j']?.forceN.value ?? 0).toBeGreaterThan(0);
    expect(data.reactions?.joints['crank_j']?.forceN.angleDeg).not.toBeNull();
    expect((data.reactions as unknown as { series?: unknown }).series).toBeUndefined();
    const off = simulate(withMotor(doc, 600), { duration: 0.02, reactions: 'off' });
    expect(off.reactions).toBeUndefined();
    expect(simulate(withMotor(doc, 600), { duration: 0.02, timestep: 1e-4 }).loops?.solver.timestepS).toBe(1e-4);
  });

  it('rejects a crankAxis that is not a revolute tree joint', () => {
    const { doc } = sliderCrank();
    expect(execute(withMotor(doc, 600), 'simulate_motion', { duration: 0.01, crankAxis: 'slide_j' }).summary).toMatch(/crankAxis/);
  });
});
