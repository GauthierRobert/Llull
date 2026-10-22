/** ENG-6: explicit body inertia, spring ends as body-frame offsets, propeller thrust work on translating bodies in the energy balance. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@dynamics/sim/simulationReport';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
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

/** A disc (r 100 mm, axis Y) and nothing else: the body is added by each test. */
const disc = (): { doc: CadDocument; id: string } => {
  const result = execute(createEmptyDocument(), 'add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0], position: [0, 0, 500] });
  return { doc: result.document, id: result.affected[0] ?? '' };
};

describe('add_rigid_body inertiaKgM2', () => {
  it('replaces the geometry inertia: a torque spins the wheel at ω = τt / Iyy of the given tensor', () => {
    const { doc, id } = disc();
    const body = execute(doc, 'add_rigid_body', { id: 'w', entityIds: [id], massKg: 2, inertiaKgM2: [1, 0.5, 1, 0, 0, 0] });
    expect(body.affected).toEqual(['w']);
    expect(body.summary).toContain('inertia as given');
    const joint = execute(body.document, 'add_body_joint', { id: 'j', kind: 'revolute', child: 'w', anchor: [0, 0, 500], axis: [0, 1, 0] });
    const motor = execute(joint.document, 'add_motor', { joint: 'j', kind: 'torque_curve', torque: 3 });
    const data = simulate(motor.document, { duration: 2 });
    expect(data.joints['j']?.finalVelocity ?? 0).toBeCloseTo((3 * 2) / 0.5, 4);
  });

  it('survives save and load, and a bad stored tensor is a load problem', () => {
    const { doc, id } = disc();
    const saved = execute(doc, 'add_rigid_body', { id: 'w', entityIds: [id], inertiaKgM2: [1, 1, 1, 0.1, 0, 0] }).document;
    const loaded = deserializeDocument(serializeDocument(saved));
    expect(loaded.dynamics?.bodies['w']?.inertiaKgM2).toEqual([1, 1, 1, 0.1, 0, 0]);
    const broken = { ...saved.dynamics, bodies: { w: { ...saved.dynamics?.bodies['w'], inertiaKgM2: [1, 1] } } };
    expect(dynamicsProblems(broken).join(' ')).toContain('inertiaKgM2 must be 6 finite numbers');
  });

  it('refuses a tensor no mass distribution has, without touching the document', () => {
    const { doc, id } = disc();
    for (const [inertiaKgM2, reason] of [
      [[1, 1, -1, 0, 0, 0], 'not positive definite'],
      [[1, 1, 3, 0, 0, 0], 'triangle inequality'],
      [[1, 1, 1, 2, 0, 0], 'not positive definite'],
    ] as const) {
      const result = execute(doc, 'add_rigid_body', { entityIds: [id], inertiaKgM2 });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain(reason);
    }
    expectPure(doc, () => execute(doc, 'add_rigid_body', { entityIds: [id], inertiaKgM2: [1, 0.5, 1, 0, 0, 0] }));
  });
});

/** Two 50 mm cubes on prismatic Z joints, 500 mm apart, no spring yet. */
const twoBlocks = (): CadDocument =>
  build([
    { command: 'add_box', params: { size: [50, 50, 50], position: [0, 0, 0], anchor: 'center' }, as: 'a' },
    { command: 'add_box', params: { size: [50, 50, 50], position: [0, 0, 500], anchor: 'center' }, as: 'b' },
    { command: 'add_rigid_body', params: { id: 'A', entityIds: ['$a'], massKg: 1 } },
    { command: 'add_rigid_body', params: { id: 'B', entityIds: ['$b'], massKg: 1 } },
    { command: 'add_body_joint', params: { id: 'ja', kind: 'prismatic', child: 'A', anchor: [0, 0, 0], axis: [0, 0, 1] } },
    { command: 'add_body_joint', params: { id: 'jb', kind: 'prismatic', child: 'B', anchor: [0, 0, 500], axis: [0, 0, 1] } },
  ]);

describe('add_spring pointFrame "body"', () => {
  it("places each end at its body's centre of mass plus the offset and stores world points", () => {
    const doc = twoBlocks();
    const spring = execute(doc, 'add_spring', {
      id: 's',
      bodyA: 'A',
      bodyB: 'B',
      pointA: [0, 0, 25],
      pointB: [0, 0, -25],
      pointFrame: 'body',
      stiffness: 100,
    });
    expect(spring.affected).toEqual(['s']);
    const stored = spring.document.dynamics?.springs?.['s'];
    stored?.pointA.forEach((c, i) => expect(c).toBeCloseTo([0, 0, 25][i] ?? 0, 9));
    stored?.pointB.forEach((c, i) => expect(c).toBeCloseTo([0, 0, 475][i] ?? 0, 9));
    expect(stored?.freeLengthM).toBeCloseTo(0.45, 9);
  });

  it('a ground end stays a world point; offsets that meet are refused', () => {
    const doc = twoBlocks();
    const grounded = execute(doc, 'add_spring', {
      id: 'g',
      bodyA: 'ground',
      bodyB: 'A',
      pointA: [0, 0, -200],
      pointB: [0, 0, 0],
      pointFrame: 'body',
      stiffness: 100,
    });
    expect(grounded.document.dynamics?.springs?.['g']?.pointA).toEqual([0, 0, -200]);
    const met = execute(doc, 'add_spring', {
      bodyA: 'A',
      bodyB: 'B',
      pointA: [0, 0, 250],
      pointB: [0, 0, -250],
      pointFrame: 'body',
      stiffness: 1,
    });
    expect(met.document).toBe(doc);
    expect(met.summary).toContain('coincide');
  });
});

describe('propeller thrust on a translating body', () => {
  it('the thrust work on the cart is input work: the balance closes within 1 %', () => {
    const doc = build([
      { command: 'add_box', params: { size: [200, 200, 200], position: [0, 0, 0], anchor: 'center' }, as: 'cart' },
      { command: 'add_cylinder', params: { radius: 100, height: 20, axis: [1, 0, 0], position: [150, 0, 0] }, as: 'prop' },
      { command: 'add_rigid_body', params: { id: 'C', entityIds: ['$cart'], massKg: 5 } },
      { command: 'add_rigid_body', params: { id: 'P', entityIds: ['$prop'], massKg: 1 } },
      { command: 'add_body_joint', params: { id: 'slide', kind: 'prismatic', child: 'C', anchor: [0, 0, 0], axis: [1, 0, 0] } },
      {
        command: 'add_body_joint',
        params: { id: 'spin', kind: 'revolute', parent: 'C', child: 'P', anchor: [150, 0, 0], axis: [1, 0, 0] },
      },
      { command: 'add_motor', params: { joint: 'spin', kind: 'torque_curve', torque: 3 } },
      {
        command: 'add_propeller',
        params: { joint: 'spin', diameter: 0.5, thrustCoefficient: 0.1, powerCoefficient: 0.05, thrustDirection: [1, 0, 0] },
      },
      { command: 'set_gravity', params: { gravity: [0, 0, 0] } },
    ]);
    const data = simulate(doc, { duration: 2, sampleRate: 500, energy: true });
    expect(data.joints['slide']?.finalVelocity ?? 0).toBeGreaterThan(0.5);
    expect(data.energy?.balanceErrorFraction ?? 1).toBeLessThan(0.01);
  });
});
