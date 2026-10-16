/**
 * FR-FPR-19: a model without closed loops or cylinder pressure must give byte-identical `simulate_motion` data. The hashes below were taken
 * from the output BEFORE PHY-21 slice B changed the dynamics layer; a change here is a regression unless the owner accepts a new baseline.
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

/** Geared engine + propeller with a sliding carriage hanging off the crank (tree of three joints, one gear, one motor, one propeller). */
function geared(): CadDocument {
  const crankDisc = step(createEmptyDocument(), 'add_cylinder', { radius: 60, height: 40, axis: [0, 1, 0], position: [0, 0, 800] });
  const propDisc = step(crankDisc.doc, 'add_cylinder', { radius: 150, height: 15, axis: [0, 1, 0], position: [0, 200, 800] });
  const slide = step(propDisc.doc, 'add_box', { size: [30, 30, 30], position: [100, 0, 800] });
  const crank = step(slide.doc, 'add_rigid_body', { entityIds: [crankDisc.id] });
  const prop = step(crank.doc, 'add_rigid_body', { entityIds: [propDisc.id], density: 600 });
  const carriage = step(prop.doc, 'add_rigid_body', { entityIds: [slide.id] });
  const crankJoint = step(carriage.doc, 'add_body_joint', { kind: 'revolute', child: crank.id, anchor: [0, 0, 800], axis: [0, 1, 0] });
  const propJoint = step(crankJoint.doc, 'add_body_joint', { kind: 'revolute', child: prop.id, anchor: [0, 200, 800], axis: [0, 1, 0] });
  const slideJoint = step(propJoint.doc, 'add_body_joint', {
    kind: 'prismatic',
    child: carriage.id,
    parent: crank.id,
    anchor: [100, 0, 800],
    axis: [1, 0, 0],
    damping: 2,
    initialVelocity: 0.1,
  });
  const gear = step(slideJoint.doc, 'add_gear_coupling', { driver: crankJoint.id, driven: propJoint.id, ratio: 21 / 72 });
  const motor = step(gear.doc, 'add_motor', { joint: crankJoint.id, kind: 'torque_curve', torque: 40 });
  return step(motor.doc, 'add_propeller', { joint: propJoint.id, diameter: 1.2, thrustCoefficient: 0.1, powerCoefficient: 0.05 }).doc;
}

/** Governed variant: a speed motor on a lone flywheel. */
function governed(): CadDocument {
  const disc = step(createEmptyDocument(), 'add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0], position: [0, 0, 500] });
  const body = step(disc.doc, 'add_rigid_body', { entityIds: [disc.id] });
  const joint = step(body.doc, 'add_body_joint', { kind: 'revolute', child: body.id, anchor: [0, 0, 500], axis: [0, 1, 0] });
  return step(joint.doc, 'add_motor', { joint: joint.id, kind: 'speed', rpm: 1500, maxTorque: 200 }).doc;
}

const hashOf = (doc: CadDocument, params: Record<string, unknown>): string => {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return hashText(JSON.stringify(result.data));
};

describe('simulate_motion output of models without loops or cylinders (FR-FPR-19)', () => {
  it('geared engine + propeller + carriage, summary / series / poses', () => {
    const doc = geared();
    expect([
      hashOf(doc, { duration: 2 }),
      hashOf(doc, { duration: 2, detail: 'series', sampleRate: 20 }),
      hashOf(doc, { duration: 1, detail: 'poses', sampleRate: 10, timestep: 0.0005 }),
    ]).toEqual(['c0c797254ae76540', '384fdc0af65fbb51', 'ba737fce807481b0']);
  });

  it('speed-governed flywheel', () => {
    expect(hashOf(governed(), { duration: 1, detail: 'series' })).toBe('cd62962de5d04058');
  });

  it('is deterministic run to run', () => {
    const doc = geared();
    expect(hashOf(doc, { duration: 1, detail: 'poses' })).toBe(hashOf(doc, { duration: 1, detail: 'poses' }));
    expect(execute(doc, 'simulate_motion', { duration: 1 }).summary).toContain('simulate_motion: 1 s with MuJoCo');
  });
});
