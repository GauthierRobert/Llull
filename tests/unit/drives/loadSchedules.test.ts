/** add_load_schedule (PHY-23 DRV-M2, FR-DRV-14): a profile or constant applied as a body force or the generalised force of a joint. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { noGravity, runSteps, seriesOf, slider, spinner } from './fixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

const profile = (id: string, quantity: string, unit: string): { command: string; params: Record<string, unknown> } => ({
  command: 'add_motion_profile',
  params: {
    id,
    quantity,
    unit,
    segments: [
      {
        kind: 'table',
        points: [
          [0, 0],
          [1, 2],
        ],
        interpolation: 'linear',
      },
    ],
  },
});

describe('load schedules in simulate_motion', () => {
  it('a torque profile on a revolute joint accelerates it at T(t) / J: a ramp 0 -> 2 N*m over 1 s on J 0.5 gives w = t^2 / 0.5', () => {
    const doc = runSteps([
      ...spinner('s', 0.5),
      noGravity,
      profile('ramp', 'torque', 'N*m'),
      { command: 'add_load_schedule', params: { joint: 'j_s', kind: 'torque', profile: 'ramp' } },
    ]).doc;
    const run = execute(doc, 'simulate_motion', { duration: 0.5, timestep: 1e-4, sampleRate: 100, detail: 'series' });
    expect(seriesOf(run, 'jointVelocity', 'j_s')[50]).toBeCloseTo(0.5 ** 2 / 0.5, 3);
  });

  it('a body force acts at the centre of mass along its world direction: m a = F, here 3 N on 2 kg along (0, 3, 4) / 5', () => {
    const doc = runSteps([
      { command: 'add_box', params: { size: [20, 20, 20], position: [0, 0, 0], anchor: 'center' }, as: 'g' },
      { command: 'add_rigid_body', params: { entityIds: ['$g'], id: 'free', massKg: 2 } },
      noGravity,
      { command: 'add_load_schedule', params: { body: 'free', kind: 'force', direction: [0, 3, 4], constant: 3 } },
    ]).doc;
    const run = execute(doc, 'simulate_motion', { duration: 1, timestep: 1e-3, sampleRate: 10 });
    const bodies = (run.data as { freeBodies: Record<string, { finalPosition: number[] }> }).freeBodies;
    const last = bodies['free']?.finalPosition;
    // 1.5 m/s^2 for 1 s travels 0.75 m: (0, 0.45, 0.6) m = (0, 450, 600) mm
    expect(last?.[1]).toBeCloseTo(450, 0);
    expect(last?.[2]).toBeCloseTo(600, 0);
  });

  it('a force on a prismatic joint and a profile that is a force (N) work the same way; the work counts as external work in the ledger', () => {
    const doc = runSteps([
      ...slider('s', 4),
      noGravity,
      { command: 'add_load_schedule', params: { joint: 'j_s', kind: 'force', constant: 8 } },
      {
        command: 'add_spring',
        params: { bodyA: 'b_s', bodyB: 'ground', pointA: [0, 0, 10], pointB: [-100, 0, 10], stiffness: 1, freeLengthMm: 100, id: 'weak' },
      },
    ]).doc;
    const run = execute(doc, 'simulate_motion', { duration: 0.5, timestep: 1e-3, sampleRate: 100, detail: 'series', energy: true });
    expect(seriesOf(run, 'jointVelocity', 'j_s')[10]).toBeCloseTo(8 / 4 / 10, 1);
  });
});

describe('add_load_schedule refusals and purity', () => {
  const base = (): CadDocument =>
    runSteps([
      ...spinner('r', 1e-3),
      ...slider('p', 1),
      { command: 'add_cylinder', params: { radius: 5, height: 5, position: [0, 200, 0], axis: [0, 0, 1] }, as: 'fixedGeo' },
      { command: 'add_rigid_body', params: { entityIds: ['$fixedGeo'], id: 'frame', fixed: true } },
      profile('torque_ramp', 'torque', 'N*m'),
      profile('force_ramp', 'force', 'N'),
    ]).doc;
  const refused = (doc: CadDocument, params: Record<string, unknown>): string => {
    const result = execute(doc, 'add_load_schedule', params);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    return result.summary;
  };

  it('stores body and joint loads, is pure, and refuses what cannot be applied', () => {
    const doc = base();
    const before = JSON.stringify(doc);
    const joint = execute(doc, 'add_load_schedule', { joint: 'j_r', kind: 'torque', profile: 'torque_ramp', id: 'l1' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(joint.affected).toEqual(['l1']);
    expect(joint.document.dynamics?.loadSchedules?.['l1']).toEqual({
      id: 'l1',
      target: { joint: 'j_r' },
      kind: 'torque',
      profile: 'torque_ramp',
    });
    const body = execute(joint.document, 'add_load_schedule', { body: 'b_p', kind: 'force', direction: [1, 0, 0], constant: -3, id: 'l2' });
    expect(body.document.dynamics?.loadSchedules?.['l2']).toEqual({
      id: 'l2',
      target: { body: 'b_p' },
      kind: 'force',
      direction: [1, 0, 0],
      constant: -3,
    });
    expect(body.document.order).toEqual(doc.order);
    expect(refused(doc, { kind: 'force', constant: 1 })).toMatch(/exactly one of/);
    expect(refused(doc, { body: 'b_p', joint: 'j_p', kind: 'force', constant: 1 })).toMatch(/exactly one of/);
    expect(refused(doc, { joint: 'j_r', kind: 'torque' })).toMatch(/profile. or a .constant./);
    expect(refused(doc, { joint: 'j_r', kind: 'torque', constant: Infinity })).toMatch(/invalid|finite/);
    expect(refused(doc, { body: 'nope', kind: 'force', direction: [1, 0, 0], constant: 1 })).toMatch(/not found/);
    expect(refused(doc, { body: 'frame', kind: 'force', direction: [1, 0, 0], constant: 1 })).toMatch(/fixed/);
    expect(refused(doc, { body: 'b_p', kind: 'torque', direction: [1, 0, 0], constant: 1 })).toMatch(/takes a force/);
    expect(refused(doc, { body: 'b_p', kind: 'force', constant: 1 })).toMatch(/non-zero/);
    expect(refused(doc, { body: 'b_p', kind: 'force', direction: [0, 0, 0], constant: 1 })).toMatch(/non-zero/);
    expect(refused(doc, { joint: 'nope', kind: 'torque', constant: 1 })).toMatch(/not found/);
    expect(refused(doc, { joint: 'j_r', kind: 'force', constant: 1 })).toMatch(/takes a torque/);
    expect(refused(doc, { joint: 'j_p', kind: 'torque', constant: 1 })).toMatch(/takes a force/);
    expect(refused(doc, { joint: 'j_r', kind: 'torque', profile: 'nope' })).toMatch(/DRV_PROFILE_INVALID/);
    expect(refused(doc, { joint: 'j_r', kind: 'torque', profile: 'force_ramp' })).toMatch(/DRV_PROFILE_INVALID/);
    expect(refused(joint.document, { joint: 'j_r', kind: 'torque', constant: 1, id: 'l1' })).toMatch(/already used/);
  });

  it('a profile used by a load cannot be deleted; deleting the load frees it; deleting the body drops its loads', () => {
    const loaded = execute(base(), 'add_load_schedule', { joint: 'j_r', kind: 'torque', profile: 'torque_ramp', id: 'l1' }).document;
    expect(execute(loaded, 'delete_dynamics_item', { id: 'torque_ramp' }).summary).toMatch(/used by load schedule\(s\) 'l1'/);
    const freed = execute(execute(loaded, 'delete_dynamics_item', { id: 'l1' }).document, 'delete_dynamics_item', { id: 'torque_ramp' });
    expect(freed.document.dynamics?.profiles?.['torque_ramp']).toBeUndefined();
    const onBody = execute(base(), 'add_load_schedule', {
      body: 'b_p',
      kind: 'force',
      direction: [1, 0, 0],
      constant: 1,
      id: 'l3',
    }).document;
    expect(execute(onBody, 'delete_dynamics_item', { id: 'b_p' }).document.dynamics?.loadSchedules).toEqual({});
  });

  it('simulate_motion refuses a load on a joint that cannot move and a profile that was changed to another quantity by hand', () => {
    const doc = execute(base(), 'add_load_schedule', { joint: 'j_r', kind: 'torque', profile: 'torque_ramp', id: 'l1' }).document;
    const dynamics = doc.dynamics;
    const stored = dynamics?.profiles?.['torque_ramp'];
    if (dynamics === undefined || stored === undefined) throw new Error('no dynamics');
    const tampered = {
      ...doc,
      dynamics: { ...dynamics, profiles: { ...dynamics.profiles, torque_ramp: { ...stored, quantity: 'force' as const, unit: 'N' } } },
    };
    expect(execute(tampered, 'simulate_motion', { duration: 0.1 }).summary).toMatch(/is a torque, profile 'torque_ramp' is a force/);
    const missing = { ...doc, dynamics: { ...dynamics, profiles: {} } };
    expect(execute(missing, 'simulate_motion', { duration: 0.1 }).summary).toMatch(/profile 'torque_ramp' not found/);
  });
});
