/** PHY-11 validation plans (VC-CRP-01): each draft plan of the pack replays through build_project and records its creep step. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const DIR = 'docs/physics/11-creep-viscoelasticity/validation/plans';

/** `[plan file, hold duration s, preload step, probe names]`. */
const PLANS = [
  ['crp_norton_unit_cube', 1000, false, ['centre']],
  ['crp_bar_relaxation', 3600, true, ['centre']],
  ['crp_thick_cylinder_stationary', 2000, true, ['bore', 'outer']],
  ['crp_beam_stationary_bending', 100000, true, ['top_mid', 'quarter_mid']],
] as const;

describe('creep validation plans', () => {
  it.each(PLANS)('%s replays: every step ok, a creep case with its hold and probes', (file, duration, preload, probes) => {
    const plan = JSON.parse(readFileSync(`${DIR}/${file}.plan.json`, 'utf8')) as unknown[];
    const result = execute(createEmptyDocument(), 'build_project', { actions: plan }, { ...defaultContext(), kernel });
    const steps = (result.data as { steps: { command: string; ok: boolean; summary: string }[] }).steps;
    expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
    const analysis = Object.values(result.document.analysis?.cases ?? {})[0];
    expect(analysis?.type).toBe('creep');
    expect(analysis?.creep).toMatchObject({ durationS: duration, preloadStep: preload, temperature: { kind: 'uniform', valueK: 293 } });
    expect(Object.values(analysis?.probes ?? {}).map((probe) => probe.name)).toEqual(probes);
  });
});
