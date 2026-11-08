/**
 * FLT-M1: a model without rotors or body drag must give byte-identical `simulate_motion` data after the body-kinematics port change. The hash
 * below was taken from the output BEFORE FLT-M1 (origin/main 5a15f6378): a free body pushed by a body load schedule next to a jointed propeller.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { hashText } from '@lib/hash';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  if (result.affected.length === 0) throw new Error(result.summary);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

function freeAndPropeller(): CadDocument {
  const box = step(createEmptyDocument(), 'add_box', { size: [100, 60, 40], position: [0, 0, 1000] });
  const disc = step(box.doc, 'add_cylinder', { radius: 150, height: 15, axis: [0, 1, 0], position: [500, 0, 0] });
  const free = step(disc.doc, 'add_rigid_body', { entityIds: [box.id], massKg: 1.2 });
  const prop = step(free.doc, 'add_rigid_body', { entityIds: [disc.id], density: 600 });
  const joint = step(prop.doc, 'add_body_joint', {
    kind: 'revolute',
    child: prop.id,
    anchor: [500, 0, 0],
    axis: [0, 1, 0],
    initialVelocity: 300,
  });
  const pushed = step(joint.doc, 'add_load_schedule', { body: free.id, kind: 'force', direction: [1, 0, 2], constant: 5 });
  return step(pushed.doc, 'add_propeller', { joint: joint.id, diameter: 0.3, thrustCoefficient: 0.1, powerCoefficient: 0.05 }).doc;
}

const hashOf = (doc: CadDocument, params: Record<string, unknown>): string => {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  const { engine: _engine, ...numbers } = result.data as { engine: string };
  return hashText(JSON.stringify(numbers));
};

describe('simulate_motion without rotors or body drag is unchanged by FLT-M1', () => {
  it('free body + load schedule + propeller, poses and energy', () => {
    const doc = freeAndPropeller();
    const hash = hashOf(doc, { duration: 1, detail: 'poses', energy: true, sampleRate: 20 });
    expect(hash).toBe('2b5a428976bbb9f8');
  });
});
