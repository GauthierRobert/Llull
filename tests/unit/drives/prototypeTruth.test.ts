/** check_prototype aggregation of check_motion_truth (PHY-23 DRV-M3): the dynamics check of a model with drive physics carries the truth items; one without does not. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { servoSizingDoc } from './sizingFixtures';
import { runSteps } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const check = (doc: CadDocument, durationS: number): ReturnType<typeof execute> =>
  execute(doc, 'check_prototype', { durationS }, { ...defaultContext(), kernel });

interface Check {
  check: string;
  status: string;
  items: { code: string; status: string; ids: string[]; findingKey: string }[];
}
const checksOf = (result: ReturnType<typeof execute>): Check[] => (result.data as { checks: Check[] }).checks;
const dynamicsOf = (result: ReturnType<typeof execute>): Check => checksOf(result).find((check) => check.check === 'dynamics') as Check;

describe('check_prototype with drive physics', () => {
  it('the dynamics check of the servo plan carries the truth items (ledger, timestep study, provenance) next to the check_dynamics ones', () => {
    const result = check(servoSizingDoc(), 1);
    const codes = dynamicsOf(result).items.map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining(['FPR_ENERGY_CLOSURE', 'DRV_LEDGER_CLOSURE', 'DRV_TIMESTEP_STUDY', 'DRV_PARAM_UNSOURCED']),
    );
    const unsourced = dynamicsOf(result).items.find((item) => item.code === 'DRV_PARAM_UNSOURCED');
    expect(unsourced).toMatchObject({
      status: 'warn',
      ids: ['j_load.friction'],
      findingKey: 'dynamics:DRV_PARAM_UNSOURCED:j_load.friction',
    });
    expect(result.affected).toEqual([]);
  }, 300_000);

  it('a model with no drive physics gets exactly the items it got before (no DRV items)', () => {
    const plan = JSON.parse(
      readFileSync('docs/physics/10-rigid-body-dynamics/validation/plans/rbd_compound_pendulum.plan.json', 'utf8'),
    ) as { command: string; params: Record<string, unknown> }[];
    const doc = runSteps(plan.filter((step) => step.command !== 'simulate_motion')).doc;
    const result = check(doc, 1);
    expect(dynamicsOf(result).items.filter((item) => item.code.startsWith('DRV_'))).toEqual([]);
  }, 300_000);

  it('without a physics engine the truth part is a not_run item with the reason, never a pass', () => {
    setPhysicsEngine(null);
    const result = check(servoSizingDoc(), 1);
    const skipped = dynamicsOf(result).items.find((item) => item.code === 'DRV_LEDGER_CLOSURE');
    expect(skipped?.status).toBe('not_run');
  });
});
