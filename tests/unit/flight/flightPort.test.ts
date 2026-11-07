/**
 * TR-FLT-01 port: the MuJoCo adapter gives the load callback the pose and twist of the bodies the model lists in `bodyStates` (step midpoint),
 * applies `bodyMoments`, and records `bodyVelocity`; a model without `bodyStates` gets no body state. Closed-form oracles only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  AppliedLoads,
  BodyKinematics,
  PhysicsEngine,
  SimulationBody,
  SimulationModel,
  SimulationState,
} from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

let engine: PhysicsEngine;
beforeAll(async () => {
  engine = await createMujocoPhysics();
});

const G = 9.80665;
const base = {
  transmissions: [],
  loops: [],
  servos: [],
  solver: { integrator: 'rk4', loopTimeConstant: 0.002, loopImpedance: 0.9999 },
} as const;

const freeBody = (id: string, [ixx, iyy, izz]: [number, number, number], center: [number, number, number] = [0, 0, 0]): SimulationBody => ({
  id,
  parentId: null,
  mass: 2,
  centerOfMass: center,
  inertia: [ixx, iyy, izz, 0, 0, 0],
  joint: null,
  fixed: false,
});

/** A loads callback that remembers the body state of its last call (test-only side effect). */
function recording(loads: (state: SimulationState) => AppliedLoads = () => ({ jointForces: {}, bodyForces: {} })): {
  loads: (state: SimulationState) => AppliedLoads;
  last: () => SimulationState | undefined;
} {
  let seen: SimulationState | undefined;
  return {
    loads: (state) => {
      seen = state;
      return loads(state);
    },
    last: () => seen,
  };
}

const yawOf = (q: readonly number[] | undefined): number => 2 * Math.atan2(q?.[3] ?? 0, q?.[0] ?? 1);

describe('PhysicsEngine body kinematics (TR-FLT-01)', () => {
  it('VC-FLT-01: a free body falls z = -g t²/2 and the loads see its midpoint velocity -g (t + h/2)', () => {
    const probe = recording();
    const model: SimulationModel = {
      ...base,
      gravity: [0, 0, -G],
      bodies: [freeBody('drop', [0.01, 0.01, 0.01])],
      loads: probe.loads,
      bodyStates: ['drop'],
    };
    const trace = engine.simulate(model, { duration: 2, timestep: 0.001, sampleInterval: 0.5 });
    const z = trace.bodyPosition['drop']?.at(-1)?.[2] ?? Number.NaN;
    expect(Math.abs(z - -19.6133) / 19.6133).toBeLessThan(1e-6);
    const state = probe.last();
    const body: BodyKinematics | undefined = state?.bodies?.['drop'];
    expect(state?.time).toBeCloseTo(2 - 0.0005, 12);
    expect(body?.linearVelocity[2]).toBeCloseTo(-G * (state?.time ?? 0), 9);
    expect(body?.linearVelocity[0]).toBe(0);
    expect(body?.orientation).toEqual([1, 0, 0, 0]);
    expect(trace.bodyVelocity?.['drop']?.linear.at(-1)?.[2]).toBeCloseTo(-G * 2, 9);
    expect(trace.bodyVelocity?.['drop']?.linear).toHaveLength(trace.times.length);
  });

  it('a jointed body (and a body welded to it) spinning about an offset axis: v = ω × r, angular velocity along the joint axis', () => {
    const probe = recording();
    const omega = 3;
    const model: SimulationModel = {
      ...base,
      gravity: [0, 0, 0],
      bodies: [
        {
          ...freeBody('arm', [0.01, 0.02, 0.03], [0.5, 0, 0]),
          joint: { id: 'hinge', kind: 'revolute', anchor: [0, 0, 0], axis: [0, 0, 1], damping: 0, friction: 0, initialVelocity: omega },
        },
        // welded to the arm: its velocity is not the one of the subtree centre of mass MuJoCo's cvel is taken at
        { ...freeBody('tip', [0.001, 0.001, 0.001], [0.9, 0, 0]), parentId: 'arm', fixed: true },
      ],
      loads: probe.loads,
      bodyStates: ['arm', 'tip'],
    };
    const trace = engine.simulate(model, { duration: 0.4, timestep: 0.001, sampleInterval: 0.1 });
    const body = probe.last()?.bodies?.['arm'];
    const angle = omega * (probe.last()?.time ?? 0);
    // the centre of mass at radius 0.5 m, midpoint angle ωt: v = ω ẑ × r
    expect(body?.position[0]).toBeCloseTo(0.5 * Math.cos(angle), 5);
    expect(body?.position[1]).toBeCloseTo(0.5 * Math.sin(angle), 5);
    expect(body?.linearVelocity[0]).toBeCloseTo(-omega * 0.5 * Math.sin(angle), 5);
    expect(body?.linearVelocity[1]).toBeCloseTo(omega * 0.5 * Math.cos(angle), 5);
    expect(body?.angularVelocity).toEqual([0, 0, expect.closeTo(omega, 9)]);
    expect(yawOf(body?.orientation)).toBeCloseTo(angle, 5);
    const tip = probe.last()?.bodies?.['tip'];
    expect(tip?.linearVelocity[0]).toBeCloseTo(-omega * 0.9 * Math.sin(angle), 4);
    expect(tip?.linearVelocity[1]).toBeCloseTo(omega * 0.9 * Math.cos(angle), 4);
    const sampled = trace.bodyVelocity?.['arm'];
    expect(sampled?.linear[0]).toEqual([expect.closeTo(0, 9), expect.closeTo(omega * 0.5, 9), 0]);
  });

  it('VC-FLT-08: a moment of 0.01 N·m about z on Izz = 0.012 kg·m² gives yaw acceleration 0.83333 rad/s²', () => {
    const model: SimulationModel = {
      ...base,
      gravity: [0, 0, 0],
      bodies: [freeBody('frame', [0.02, 0.03, 0.012])],
      loads: () => ({ jointForces: {}, bodyForces: {}, bodyMoments: { frame: [0, 0, 0.01] } }),
    };
    const trace = engine.simulate(model, { duration: 1, timestep: 0.001, sampleInterval: 0.5 });
    const alpha = (2 * yawOf(trace.bodyOrientation['frame']?.at(-1))) / 1;
    expect(Math.abs(alpha - 0.01 / 0.012) / (0.01 / 0.012)).toBeLessThan(1e-6);
    expect(trace.bodyVelocity).toBeUndefined();
  });

  it('a model without bodyStates gives the loads no body state', () => {
    const probe = recording();
    const model: SimulationModel = { ...base, gravity: [0, 0, -G], bodies: [freeBody('drop', [0.01, 0.01, 0.01])], loads: probe.loads };
    engine.simulate(model, { duration: 0.01, timestep: 0.001, sampleInterval: 0.01 });
    expect(probe.last()?.bodies).toBeUndefined();
  });
});
