/**
 * The body-state pass (mj_kinematics + mj_comPos + mj_comVel) runs before the actuator block, the servo gain schedule and the constraint
 * physics of every step when a rotor or a body drag lists bodies. It only recomputes position / velocity quantities of the current state, so
 * a model with datasheet motors and drives, a speed governor, transmissions with backlash and loss, joint physics and load schedules gives
 * exactly the same joint, motor and drive results with an idle rotor (no load) as without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { DYNAMICS_SEED } from '../../helpers/pluginSliceSeeds';
import { rotorParams, step } from './flightFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

/** The drive seed plus a speed-governed flywheel (a servo), without any flight record. */
function driveModel(): CadDocument {
  const { flight: _flight, ...seed } = DYNAMICS_SEED.build();
  const disc = step(seed, 'add_cylinder', { radius: 50, height: 10, axis: [0, 0, 1], position: [0, -300, 0] });
  const body = step(disc.doc, 'add_rigid_body', { entityIds: [disc.id], id: 'flywheel', massKg: 1 });
  const joint = step(body.doc, 'add_body_joint', { kind: 'revolute', child: 'flywheel', anchor: [0, -300, 0], axis: [0, 0, 1], id: 'jf' });
  return step(joint.doc, 'add_motor', { joint: 'jf', kind: 'speed', rpm: 600, maxTorque: 5, id: 'gov' }).doc;
}

const run = (doc: CadDocument): Record<string, unknown> => {
  const result = execute(doc, 'simulate_motion', { duration: 0.1, timestep: 0.00002, detail: 'drives', energy: true });
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Record<string, unknown>;
};

describe('flight body state next to actuators, servos and constraint physics', () => {
  it('an idle rotor (rpm 0) leaves every joint, motor, drive and energy result unchanged', () => {
    const base = driveModel();
    const withRotor = step(base, 'add_rotor', rotorParams({ body: 'wheel', rpm: 0, hub: [50, 0, 0] })).doc;
    const without = run(base);
    const flown = run(withRotor);
    expect(flown['flight']).toBeDefined();
    for (const key of ['joints', 'motors', 'drives', 'transmissions', 'energy', 'ledger', 'series'])
      expect(JSON.stringify(flown[key]), key).toBe(JSON.stringify(without[key]));
  });
});
