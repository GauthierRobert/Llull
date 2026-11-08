/** PHY-06 validation plan cnt_ssnp154_cylinder_block replayed through build_project (VC-CNT-01): every step runs, the pair is recorded. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { meshRequest } from '@cae/hash/meshRequest';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

interface Action {
  command: string;
  params: Record<string, unknown>;
}

const PLAN = 'docs/physics/06-contact-joints/validation/plans/cnt_ssnp154_cylinder_block.plan.json';

/** The plan with hex_dominant meshing replaced by tet (the only solid family built), the one deviation from the file. */
function replay(tetOnly: boolean): ReturnType<typeof execute> {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8')) as Action[];
  const actions = plan.map((action) =>
    tetOnly && action.params['elementFamily'] === 'hex_dominant'
      ? { ...action, params: { ...action.params, elementFamily: 'tet' } }
      : action,
  );
  return execute(createEmptyDocument(), 'build_project', { actions }, { ...defaultContext(), kernel });
}

describe('cnt_ssnp154_cylinder_block plan', () => {
  it('runs every step including add_contact_pair, records the surface_to_surface pair and asks the mesher for its faces', () => {
    const result = replay(true);
    const steps = (result.data as { steps: { command: string; ok: boolean; summary: string }[] }).steps;
    expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
    const [analysisId = ''] = Object.keys(result.document.analysis?.cases ?? {});
    const contact = result.document.analysis?.cases[analysisId]?.contact;
    expect(contact?.formulation).toBe('surface_to_surface');
    const pair = Object.values(contact?.pairs ?? {})[0];
    expect(pair).toMatchObject({
      name: 'roller_block',
      behaviour: { kind: 'linear', slope: 3500000 },
      adjust: { kind: 'clearance', value: 0.001 },
    });
    const request = meshRequest(result.document, analysisId);
    expect('targets' in request && request.targets.filter((target) => target.key.startsWith('CP_')).length).toBe(2);
  });

  it('fails only at hex_dominant meshing as written (set_mesh_controls builds tet only)', () => {
    const steps = (replay(false).data as { steps: { command: string; ok: boolean }[] }).steps;
    expect(steps.filter((step) => !step.ok).map((step) => step.command)).toEqual(['set_mesh_controls']);
  });
});
