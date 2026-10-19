/** Point springs (add_spring), motor / governor / propeller input work in the energy balance, springs in render_motion. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { lightFourBarActions } from './lightFourBarFixture';
import { expectPure } from '../helpers/expectNoOp';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

const build = (actions: readonly Record<string, unknown>[]): CadDocument =>
  execute(createEmptyDocument(), 'build_project', { actions }).document;

const simulate = (doc: CadDocument, params: Record<string, unknown>): SimulationData => {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as SimulationData;
};

/** Mean spacing of the upward crossings of `level`. */
function period(times: readonly number[], values: readonly number[], level: number): number {
  const up: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const [a, b] = [(values[i - 1] ?? 0) - level, (values[i] ?? 0) - level];
    if (a < 0 && b >= 0) up.push((times[i - 1] ?? 0) + ((times[i] ?? 0) - (times[i - 1] ?? 0)) * (-a / (b - a)));
  }
  expect(up.length).toBeGreaterThan(3);
  return ((up[up.length - 1] ?? 0) - (up[0] ?? 0)) / (up.length - 1);
}

/** A 2 kg block that can only move along Z, hanging on a spring from a ground point 500 mm above it. */
const hangingMass = (spring: Record<string, unknown>): Record<string, unknown>[] => [
  { command: 'add_box', params: { size: [50, 50, 50], position: [0, 0, 0] }, as: 'b' },
  { command: 'add_rigid_body', params: { id: 'm', entityIds: ['$b'], massKg: 2 } },
  { command: 'add_body_joint', params: { id: 'slide', kind: 'prismatic', child: 'm', anchor: [0, 0, 0], axis: [0, 0, 1] } },
  {
    command: 'add_spring',
    params: { id: 'sp', bodyA: 'ground', bodyB: 'm', pointA: [0, 0, 500], pointB: [0, 0, 0], stiffness: 800, ...spring },
  },
];

describe('add_spring: vertical mass on a spring to the ground', () => {
  it('oscillates with T = 2π·sqrt(m/k) within 0.5 % and rests at the static deflection m·g/k within 0.5 %', () => {
    const [mass, k] = [2, 800];
    const free = build(hangingMass({}));
    expect(free.dynamics?.springs?.['sp']).toMatchObject({ bodyA: 'ground', bodyB: 'm', stiffness: 800, damping: 0, freeLengthM: 0.5 });
    // released at the free length: swings between 0 and -2·m·g/k about -m·g/k
    const data = simulate(free, { duration: 3, sampleRate: 2000, detail: 'series' });
    const expected = 2 * Math.PI * Math.sqrt(mass / k);
    const measured = period(data.series?.times ?? [], data.series?.jointPosition['slide'] ?? [], -(mass * 9.81) / k);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.005);
    expect(data.energy?.maxDeviationFraction ?? 1).toBeLessThan(0.005);
    expect(data.springs?.['sp']?.maxLengthM).toBeCloseTo(0.5 + (2 * mass * 9.81) / k, 3);
    // with damping it settles at the static deflection
    const damped = simulate(build(hangingMass({ damping: 40 })), { duration: 4, sampleRate: 100 });
    const rest = damped.joints['slide']?.finalPosition ?? 0;
    expect(Math.abs(rest + (mass * 9.81) / k) / ((mass * 9.81) / k)).toBeLessThan(0.005);
    expect(damped.springs?.['sp']?.finalForceN).toBeCloseTo(mass * 9.81, 1);
    expect(damped.energy?.dissipatedJ ?? 0).toBeGreaterThan(0);
  });

  it('a damped spring dissipates exactly the energy it loses (balance closes within 0.5 %)', () => {
    const data = simulate(build(hangingMass({ damping: 10 })), { duration: 2, sampleRate: 1000 });
    expect(data.energy?.balanceErrorFraction ?? 1).toBeLessThan(0.005);
    expect(data.energy?.inputWorkJ).toBeCloseTo(0, 9);
  });

  it('states the energy balance in the summary of a lossy run without motors', () => {
    const summary = execute(build(hangingMass({ damping: 10 })), 'simulate_motion', { duration: 2, sampleRate: 1000 }).summary;
    expect(summary).toMatch(/balance initial \+ input - dissipated - propellers - final = /);
  });

  it('freeLengthMm and preloadN set the force at the modelled pose', () => {
    const sized = execute(build(hangingMass({}).slice(0, 3)), 'add_spring', {
      id: 'a',
      bodyA: 'ground',
      bodyB: 'm',
      pointA: [0, 0, 500],
      pointB: [0, 0, 0],
      stiffness: 1000,
      freeLengthMm: 450,
    });
    expect(sized.document.dynamics?.springs?.['a']?.freeLengthM).toBeCloseTo(0.45, 12);
    expect(sized.summary).toMatch(/free length 450 mm, length at the modelled pose 500 mm, force there 50 N \(pulling together\)/);
    const loaded = execute(sized.document, 'add_spring', {
      id: 'b',
      bodyA: 'm',
      bodyB: 'ground',
      pointA: [0, 0, 0],
      pointB: [0, 0, 500],
      stiffness: 1000,
      preloadN: 100,
    });
    expect(loaded.document.dynamics?.springs?.['b']?.freeLengthM).toBeCloseTo(0.4, 12);
    const pushing = execute(sized.document, 'add_spring', {
      bodyA: 'ground',
      bodyB: 'm',
      pointA: [0, 0, 500],
      pointB: [0, 0, 0],
      stiffness: 1000,
      preloadN: -50,
    });
    expect(pushing.summary).toMatch(/pushing apart/);
    expect(pushing.document.dynamics?.springs?.[pushing.affected[0] ?? '']).toBeDefined();
  });
});

describe('add_spring: mechanisms keep their energy', () => {
  it('a rocker (pendulum) with a diagonal spring to the ground: undamped energy drift < 0.5 %', () => {
    const doc = build([
      { command: 'set_units', params: { units: 'mm' } },
      { command: 'add_sphere', params: { radius: 10, position: [0, 0, -1000] }, as: 'bob' },
      { command: 'add_rigid_body', params: { id: 'pend', entityIds: ['$bob'], massKg: 1 } },
      {
        command: 'add_body_joint',
        params: { id: 'pivot', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0], initialRpm: 12 },
      },
      {
        command: 'add_spring',
        params: { id: 'diag', bodyA: 'ground', bodyB: 'pend', pointA: [600, 0, -500], pointB: [0, 0, -1000], stiffness: 150 },
      },
    ]);
    const data = simulate(doc, { duration: 6, sampleRate: 500 });
    expect(data.energy?.maxDeviationFraction ?? 1).toBeLessThan(0.005);
    expect(data.joints['pivot']?.peakVelocity ?? 0).toBeGreaterThan(0.5);
    expect(Math.abs(data.springs?.['diag']?.peakForceN ?? 0)).toBeGreaterThan(1);
  });

  it('a four-bar with a spring from the ground to the coupler: undamped energy drift < 0.5 %', () => {
    const doc = build([
      ...lightFourBarActions.filter((action) => action['command'] !== 'add_motor'),
      {
        command: 'add_spring',
        params: { id: 'sp', bodyA: 'ground', bodyB: 'coupler', pointA: [60, 120, 0], pointB: [76.94, 53.556, 0], stiffness: 400 },
      },
    ]);
    const data = simulate(doc, { duration: 2 });
    expect(data.energy?.maxDeviationFraction ?? 1).toBeLessThan(0.005);
    expect(data.springs?.['sp']?.peakForceN ?? 0).toBeGreaterThan(0);
  });
});

describe('energy balance with input work', () => {
  const flywheel = (motor: Record<string, unknown>, extra: Record<string, unknown>[] = []): CadDocument =>
    build([
      { command: 'add_cylinder', params: { radius: 200, height: 30, axis: [0, 1, 0], position: [0, 0, 0] }, as: 'd' },
      { command: 'add_rigid_body', params: { id: 'fly', entityIds: ['$d'], massKg: 8 } },
      { command: 'add_body_joint', params: { id: 'j', kind: 'revolute', child: 'fly', anchor: [0, 0, 0], axis: [0, 1, 0], damping: 0.5 } },
      { command: 'add_motor', params: { joint: 'j', ...motor } },
      ...extra,
    ]);

  it('a torque-curve motor on a viscously damped flywheel: input work = dissipated + ΔKE within 1 %', () => {
    // steady speed T/c = 2 / 0.5 = 4 rad/s, time constant I/c = 0.16 / 0.5 = 0.32 s
    const doc = flywheel({ kind: 'torque_curve', curve: [[0, 2]], throttle: 1 });
    const data = simulate(doc, { duration: 3, sampleRate: 200, energy: true });
    const e = data.energy;
    expect(e?.inputWorkJ ?? 0).toBeGreaterThan(5);
    const sink = (e?.dissipatedJ ?? 0) + (e?.finalKineticJ ?? 0) - (e?.initialTotalJ ?? 0);
    expect(Math.abs((e?.inputWorkJ ?? 0) - sink) / sink).toBeLessThan(0.01);
    expect(Math.abs(e?.balanceErrorFraction ?? 1)).toBeLessThan(0.01);
    expect(Math.abs(e?.balanceErrorJ ?? 1)).toBeLessThan(0.01 * (e?.inputWorkJ ?? 0));
    // steady state: kinetic energy = 1/2 I (T/c)^2
    expect(e?.finalKineticJ).toBeCloseTo(0.5 * 0.16 * 16, 2);
    expect(execute(doc, 'simulate_motion', { duration: 3, energy: true }).summary).toMatch(
      /Input work [\d.]+ J .* balance .* = -?[\d.]+ J/,
    );
  });

  it('a speed governor (servo) closes the balance within 1 %', () => {
    const doc = flywheel({ kind: 'speed', rpm: 60, maxTorque: 50 });
    const data = simulate(doc, { duration: 4, sampleRate: 200, energy: true, detail: 'series' });
    const e = data.energy;
    expect(e?.inputWorkJ ?? 0).toBeGreaterThan(1);
    expect(e?.balanceErrorFraction ?? 1).toBeLessThan(0.01);
    expect(data.series?.energy?.input.at(-1)).toBeCloseTo(e?.inputWorkJ ?? 0, 9);
  });

  it('a motor driving a propeller: the shaft work is absorbed by the propeller and the balance closes', () => {
    const doc = flywheel({ kind: 'torque_curve', curve: [[0, 3]], throttle: 1 }, [
      { command: 'add_propeller', params: { joint: 'j', diameter: 0.5, thrustCoefficient: 0.1, powerCoefficient: 0.05 } },
    ]);
    const e = simulate(doc, { duration: 4, sampleRate: 200, energy: true }).energy;
    expect(e?.propellerWorkJ ?? 0).toBeGreaterThan(0);
    expect(e?.balanceErrorFraction ?? 1).toBeLessThan(0.01);
  });

  it('a body without motors reports zero input work', () => {
    const e = simulate(build(hangingMass({})), { duration: 1, energy: true }).energy;
    expect(e?.inputWorkJ).toBeCloseTo(0, 9);
    expect(e?.propellerWorkJ).toBe(0);
  });
});

describe('add_spring: failures, persistence, deletion', () => {
  const base = { bodyA: 'ground', bodyB: 'm', pointA: [0, 0, 500], pointB: [0, 0, 0], stiffness: 800 };

  it('is a no-op on bad input and never mutates the document', () => {
    const doc = build(hangingMass({}));
    const before = JSON.stringify(doc);
    const rejected: [Record<string, unknown>, RegExp][] = [
      [{ ...base, bodyB: 'nope' }, /body 'nope' not found/],
      [{ ...base, bodyA: 'm' }, /two different bodies/],
      [{ ...base, pointB: [0, 0, 500] }, /coincide/],
      [{ ...base, freeLengthMm: 400, preloadN: 10 }, /not both/],
      [{ ...base, preloadN: 1e6 }, /negative free length/],
      [{ ...base, id: 'sp' }, /already used/],
      [{ ...base, id: 'm' }, /already used/],
    ];
    for (const [params, why] of rejected) {
      const result = execute(doc, 'add_spring', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(why);
    }
    expect(execute(doc, 'add_spring', { ...base, stiffness: 0 }).affected).toEqual([]);
    expect(execute(doc, 'add_spring', { ...base, damping: -1 }).affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('a successful add_spring leaves its input document untouched', () => {
    const doc = build(hangingMass({}));
    expectPure(doc, () => {
      const result = execute(doc, 'add_spring', { ...base, id: 'sp2' });
      expect(result.affected).toEqual(['sp2']);
    });
  });

  it('refuses a spring that joins the ground to a fixed body, or two fixed bodies', () => {
    const doc = build([
      { command: 'add_box', params: { size: [50, 50, 50] }, as: 'b' },
      { command: 'add_rigid_body', params: { id: 'frame', entityIds: ['$b'], fixed: true } },
    ]);
    const result = execute(doc, 'add_spring', { ...base, bodyB: 'frame' });
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/could not move anything/);
  });

  it('is removed by delete_dynamics_item, by its body, and counted in the cascade', () => {
    const doc = build(hangingMass({}));
    const own = execute(doc, 'delete_dynamics_item', { id: 'sp' });
    expect(own.document.dynamics?.springs).toEqual({});
    expect(own.document.dynamics?.bodies['m']).toBeDefined();
    const withBody = execute(doc, 'delete_dynamics_item', { id: 'm' });
    expect(withBody.document.dynamics?.springs).toEqual({});
    expect(withBody.summary).toMatch(/removed 'm' and 2 dependent record/);
    expect(doc.dynamics?.springs?.['sp']).toBeDefined();
  });

  it('is validated on load, and survives a save / load round trip', () => {
    const doc = build(hangingMass({ damping: 3 }));
    const springs = JSON.parse(JSON.stringify(doc.dynamics)) as Record<string, unknown>;
    expect(dynamicsProblems(springs)).toEqual([]);
    const patched = (patch: Record<string, unknown>): string[] =>
      dynamicsProblems({
        ...springs,
        springs: { sp: { ...(springs['springs'] as Record<string, Record<string, unknown>>)['sp'], ...patch } },
      });
    expect(patched({ stiffness: 0 })[0]).toMatch(/stiffness must be > 0/);
    expect(patched({ freeLengthM: -1 })[0]).toMatch(/freeLengthM >= 0/);
    expect(patched({ pointA: [1, 2] })[0]).toMatch(/pointA and pointB/);
    expect(patched({ bodyB: 'ground', bodyA: 'ground' })[0]).toMatch(/two different body ids/);
    expect(dynamicsProblems({ ...springs, springs: 5 })[0]).toMatch(/springs must be an object/);
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.dynamics?.springs?.['sp']).toMatchObject({ stiffness: 800, damping: 3, bodyA: 'ground', freeLengthM: 0.5 });
  });

  it('simulate_motion refuses a spring on a missing body', () => {
    const doc = build(hangingMass({}));
    if (doc.dynamics === undefined) throw new Error('fixture');
    const sp = doc.dynamics.springs?.['sp'];
    if (sp === undefined) throw new Error('fixture');
    const broken = { ...doc, dynamics: { ...doc.dynamics, springs: { sp: { ...sp, bodyB: 'ghost' } } } };
    expect(execute(broken, 'simulate_motion', { duration: 0.01 }).summary).toMatch(/spring sp: ghost is not a rigid body/);
  });
});

describe('render_motion draws springs', () => {
  it('draws a zig-zag between the attachment points, which follow the body', () => {
    const doc = build(hangingMass({}));
    const result = execute(doc, 'render_motion', { frames: 3, duration: 0.15, width: 240, height: 200, view: 'front' });
    const data = result.data as { svg: string; frames: { springs?: Record<string, { a: number[]; b: number[]; length: number }> }[] };
    expect(data.svg.match(/stroke="#7cfc9a"/g)?.length).toBe(3);
    const [first, last] = [data.frames[0]?.springs?.['sp'], data.frames[2]?.springs?.['sp']];
    expect(first?.length).toBeCloseTo(500, 3);
    expect(first?.a).toEqual([0, 0, 500]);
    expect(last?.a).toEqual([0, 0, 500]);
    expect(last?.b[2] ?? 0).toBeLessThan(-40);
    expect(last?.length ?? 0).toBeGreaterThan(540);
    // a mechanism without springs draws none
    const plain = execute(build(hangingMass({}).slice(0, 3)), 'render_motion', { frames: 2, duration: 0.1 });
    expect((plain.data as { svg: string }).svg).not.toContain('#7cfc9a');
  });
});
