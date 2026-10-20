/** The drop-test template on the own solver (validation plan exp_drop_box_llull, VC-EXP-51 / 67b set-up). */
import { describe, expect, it } from 'vitest';
import { buildExplicitJob } from '@cae/index';
import { replayPlan } from './support';

describe('exp_drop_box_llull plan', () => {
  it('sets up a 50 mm aluminium-like box 1.2 m above a rigid floor under gravity, 4 x 4 x 4 hex8', () => {
    const { doc, aliases } = replayPlan('exp_drop_box_llull');
    const analysisId = aliases['an'] ?? '';
    const analysis = doc.analysis?.cases[analysisId];
    expect(analysis?.solver).toBe('llull_explicit');
    expect(analysis?.explicit?.gravity?.[2]).toBeCloseTo(-9806.65, 9);
    const built = buildExplicitJob(doc, analysisId, null);
    if (!built.ok) throw new Error(built.message);
    expect(built.job.mesh.hex8.length / 8).toBe(64);
    expect(built.job.walls).toEqual([{ name: 'floor', point: [0, 0, 0], normal: [0, 0, 1] }]);
    expect(built.job.materials[0]).toMatchObject({ E: 70000, nu: 0.33 });
    expect(built.job.initialVelocity.every((value) => value === 0)).toBe(true);
  });
});
