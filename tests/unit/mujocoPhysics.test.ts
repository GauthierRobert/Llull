/**
 * The MuJoCo adapter against closed-form rigid-body results (no CAD geometry involved): if these hold, the engine boundary — units, frames,
 * inertia, joints, gear constraints, applied loads — is wired correctly.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PhysicsEngine, SimulationBody, SimulationModel } from '@core/dynamics/physicsEngine';
import { speedServoGains } from '@core/dynamics/forceLaws';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

let engine: PhysicsEngine;
beforeAll(async () => {
  engine = await createMujocoPhysics();
});

/** No loop closures, default solver. */
const tree = { loops: [], solver: { integrator: 'rk4', loopTimeConstant: 0.002, loopImpedance: 0.9999 } } as const;

const noLoads = (): { jointForces: Record<string, number>; bodyForces: Record<string, [number, number, number]> } => ({
  jointForces: {},
  bodyForces: {},
});

/** A disc spinning about world Z through `center`, with axial inertia `axial`. */
function rotor(id: string, center: [number, number, number], mass: number, axial: number, parentId: string | null = null): SimulationBody {
  return {
    id,
    parentId,
    mass,
    centerOfMass: center,
    inertia: [axial / 2, axial / 2, axial, 0, 0, 0],
    fixed: false,
    joint: { id: `${id}-hinge`, kind: 'revolute', anchor: center, axis: [0, 0, 1], damping: 0, friction: 0, initialVelocity: 0 },
  };
}

const last = (series: number[] | undefined): number => series?.[series.length - 1] ?? Number.NaN;

describe('MuJoCo physics engine', () => {
  it('reports its version', () => {
    expect(engine.name).toMatch(/^MuJoCo 3\.\d+\.\d+/);
  });

  it('constant torque on a flywheel: ω = τt/I and θ = τt²/(2I)', () => {
    const model: SimulationModel = {
      gravity: [0, 0, -9.81],
      bodies: [rotor('wheel', [0, 0, 1], 10, 0.5)],
      gears: [],
      ...tree,
      ...tree,
      servos: [],
      loads: () => ({ jointForces: { 'wheel-hinge': 2 }, bodyForces: {} }),
    };
    const trace = engine.simulate(model, { duration: 3, timestep: 0.001, sampleInterval: 0.1 });
    expect(last(trace.times)).toBeCloseTo(3, 9);
    expect(trace.times).toHaveLength(31);
    expect(last(trace.jointVelocity['wheel-hinge'])).toBeCloseTo((2 * 3) / 0.5, 8);
    expect(last(trace.jointPosition['wheel-hinge'])).toBeCloseTo((2 * 9) / (2 * 0.5), 6);
    const orientation = trace.bodyOrientation['wheel']?.[10];
    // after 1 s the wheel turned θ = 2 rad about +Z: q = [cos 1, 0, 0, sin 1]
    expect(orientation?.[0]).toBeCloseTo(Math.cos(1), 6);
    expect(orientation?.[3]).toBeCloseTo(Math.sin(1), 6);
  });

  it('a gear pair moves at the ratio and the driver feels the reflected inertia I1 + r²·I2', () => {
    const ratio = -1 / 3;
    const model: SimulationModel = {
      gravity: [0, 0, 0],
      bodies: [rotor('pinion', [0, 0, 0], 1, 0.02), rotor('wheel', [0.4, 0, 0], 5, 0.9)],
      gears: [{ id: 'mesh', driver: 'pinion-hinge', driven: 'wheel-hinge', ratio }],
      ...tree,
      servos: [],
      loads: () => ({ jointForces: { 'pinion-hinge': 1 }, bodyForces: {} }),
    };
    const trace = engine.simulate(model, { duration: 2, timestep: 0.0005, sampleInterval: 0.5 });
    const expected = (1 * 2) / (0.02 + ratio * ratio * 0.9);
    const pinion = last(trace.jointVelocity['pinion-hinge']);
    expect(Math.abs(pinion - expected) / expected).toBeLessThan(2e-3);
    expect(last(trace.jointVelocity['wheel-hinge']) / pinion).toBeCloseTo(ratio, 3);
  });

  it('a compound pendulum swings with the small-angle period T = 2π·sqrt(I_pivot / (m·g·d))', () => {
    const [mass, d, iCenter] = [2, 0.5, 0.01];
    const pendulum: SimulationBody = {
      id: 'bob',
      parentId: null,
      mass,
      centerOfMass: [0, 0, -d],
      inertia: [iCenter, iCenter, iCenter, 0, 0, 0],
      fixed: false,
      joint: { id: 'pivot', kind: 'revolute', anchor: [0, 0, 0], axis: [0, 1, 0], damping: 0, friction: 0, initialVelocity: 0.05 },
    };
    const trace = engine.simulate(
      { gravity: [0, 0, -9.81], bodies: [pendulum], gears: [], ...tree, servos: [], loads: noLoads },
      { duration: 4, timestep: 0.0005, sampleInterval: 0.0005 },
    );
    const velocity = trace.jointVelocity['pivot'] ?? [];
    // successive downward zero crossings of the angle = successive positive velocity peaks; use upward zero crossings of velocity
    const crossings: number[] = [];
    for (let i = 1; i < velocity.length; i++) {
      const [before, after] = [velocity[i - 1] ?? 0, velocity[i] ?? 0];
      if (before < 0 && after >= 0)
        crossings.push(trace.times[i - 1]! + ((trace.times[i]! - trace.times[i - 1]!) * -before) / (after - before));
    }
    const period = (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1);
    const expected = 2 * Math.PI * Math.sqrt((iCenter + mass * d * d) / (mass * 9.81 * d));
    expect(Math.abs(period - expected) / expected).toBeLessThan(1e-3);
  });

  it('applies a world force at the centre of mass of a free body: x = F t² / (2m)', () => {
    const block: SimulationBody = {
      id: 'block',
      parentId: null,
      mass: 4,
      centerOfMass: [0, 0, 0],
      inertia: [1, 1, 1, 0, 0, 0],
      fixed: false,
      joint: null,
    };
    const trace = engine.simulate(
      {
        gravity: [0, 0, 0],
        bodies: [block],
        gears: [],
        ...tree,
        servos: [],
        loads: () => ({ jointForces: {}, bodyForces: { block: [8, 0, 0] } }),
      },
      { duration: 1, timestep: 0.001, sampleInterval: 1 },
    );
    expect(trace.bodyPosition['block']?.[1]?.[0]).toBeCloseTo(1, 6);
  });

  it('a speed servo reports its force at the sampled state: F = I dω/dt through the spin-up from rest', () => {
    const [timestep, inertia] = [0.001, 0.5];
    const model: SimulationModel = {
      gravity: [0, 0, 0],
      bodies: [rotor('wheel', [0, 0, 1], 10, inertia)],
      gears: [],
      ...tree,
      servos: [
        { id: 'drive', joint: 'wheel-hinge', targetVelocity: 10, stiffness: inertia * 250 ** 2, damping: 2 * inertia * 250, maxForce: 1e9 },
      ],
      loads: noLoads,
    };
    const trace = engine.simulate(model, { duration: 0.1, timestep, sampleInterval: timestep });
    const [force, omega] = [trace.servoForce['drive'] ?? [], trace.jointVelocity['wheel-hinge'] ?? []];
    const rate = (k: number): number =>
      ((omega[k - 2] ?? 0) - 8 * (omega[k - 1] ?? 0) + 8 * (omega[k + 1] ?? 0) - (omega[k + 2] ?? 0)) / (12 * timestep);
    const peak = Math.max(...force.map(Math.abs));
    const worst = Math.max(...Array.from({ length: 40 }, (_, i) => Math.abs((force[i + 3] ?? 0) - inertia * rate(i + 3))));
    expect(peak).toBeGreaterThan(100);
    expect(worst / peak).toBeLessThan(1e-3);
  });

  it('a saturated speed servo does not overshoot its target on spin-up (anti-windup)', () => {
    const [timestep, inertia, target] = [0.001, 0.5, 10];
    const model: SimulationModel = {
      gravity: [0, 0, 0],
      bodies: [rotor('wheel', [0, 0, 1], 10, inertia)],
      gears: [],
      ...tree,
      servos: [{ id: 'drive', joint: 'wheel-hinge', targetVelocity: target, ...speedServoGains(inertia, timestep), maxForce: 2 }],
      loads: noLoads,
    };
    const trace = engine.simulate(model, { duration: 12, timestep, sampleInterval: 0.01 });
    const omega = trace.jointVelocity['wheel-hinge'] ?? [];
    expect(Math.max(...(trace.servoForce['drive'] ?? []).map(Math.abs))).toBeCloseTo(2, 6);
    expect(Math.max(...omega)).toBeLessThan(target * 1.001);
    expect(last(omega)).toBeCloseTo(target, 6);
  });

  it('anti-windup holds in the negative sense: target -10 rad/s from rest never goes below -10.01 and settles at -10', () => {
    const [timestep, inertia, target] = [0.001, 0.5, -10];
    const model: SimulationModel = {
      gravity: [0, 0, 0],
      bodies: [rotor('wheel', [0, 0, 1], 10, inertia)],
      gears: [],
      ...tree,
      servos: [{ id: 'drive', joint: 'wheel-hinge', targetVelocity: target, ...speedServoGains(inertia, timestep), maxForce: 2 }],
      loads: noLoads,
    };
    const omega = engine.simulate(model, { duration: 12, timestep, sampleInterval: 0.01 }).jointVelocity['wheel-hinge'] ?? [];
    expect(Math.min(...omega)).toBeGreaterThan(-10.01);
    expect(last(omega)).toBeCloseTo(-10, 6);
  });

  it('rejects a model MuJoCo cannot compile', () => {
    const broken: SimulationBody = { ...rotor('bad', [0, 0, 0], -1, 0.1) };
    expect(() =>
      engine.simulate(
        { gravity: [0, 0, 0], bodies: [broken], gears: [], ...tree, servos: [], loads: noLoads },
        { duration: 0.1, timestep: 0.001, sampleInterval: 0.1 },
      ),
    ).toThrow();
  });
});
