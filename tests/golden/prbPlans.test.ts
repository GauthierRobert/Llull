/**
 * Golden pins of the PRB validation plans (docs/physics/18-probabilistic-sensitivity/validation/plans): the normalized document, the VC-PRB-06 numbers,
 * and VC-PRB-18: save -> load -> replay keeps the probabilistic slice identical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { normalize } from './normalize';

const PLANS = 'docs/physics/18-probabilistic-sensitivity/validation/plans';

interface Step {
  command: string;
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
}

function run(name: string): { steps: Step[]; document: CadDocument } {
  const actions = JSON.parse(readFileSync(`${PLANS}/${name}.plan.json`, 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const steps = (result.data as { steps: Step[] }).steps;
  expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { steps, document: result.document };
}

describe('prb_box_mass plan (VC-PRB-06, VC-PRB-18)', () => {
  const plan = run('prb_box_mass');

  it('the response, three bound variables and the limit state are recorded; the numbers are the closed forms', () => {
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const sensitivity = plan.steps.find((step) => step.command === 'parameter_sensitivity')?.data as {
      rows: Array<{ derivative: number; elasticity: number }>;
    };
    [0.54, 1.08, 2.16].forEach((expected, i) => {
      expect(Math.abs((sensitivity.rows[i]?.derivative ?? 0) / expected - 1)).toBeLessThan(1e-6);
      expect(Math.abs((sensitivity.rows[i]?.elasticity ?? 0) - 1)).toBeLessThan(1e-6);
    });
    const propagated = plan.steps.find((step) => step.command === 'propagate_uncertainty')?.data as {
      limitStates: Record<string, { g: { mean: number; sd: number } }>;
    };
    const g = propagated.limitStates['mass_budget']?.g;
    expect(Math.abs((g?.mean ?? 0) - 0.4)).toBeLessThan(0.02);
    expect(Math.abs((g?.sd ?? 0) / 0.16200135 - 1)).toBeLessThan(0.05);
  }, 120_000);

  it('replaying the plan on a fresh document gives the identical document', () => {
    expect(normalize(run('prb_box_mass').document)).toEqual(normalize(plan.document));
  }, 120_000);

  it('save, load and replay_history keep the probabilistic slice deep-equal (VC-PRB-18)', () => {
    const loaded = deserializeDocument(serializeDocument(plan.document));
    expect(loaded.probabilistic).toEqual(plan.document.probabilistic);
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(replayed.probabilistic).toEqual(plan.document.probabilistic);
    expect(Object.keys(replayed.probabilistic?.responses ?? {})).toEqual(['mass']);
  }, 120_000);
});

describe('prb_ishigami_sobol plan (VC-PRB-05)', () => {
  it('runs through the plan runner and the indices stay within 0.03 of the closed form', () => {
    const plan = run('prb_ishigami_sobol');
    const data = plan.steps.find((step) => step.command === 'sensitivity_indices')?.data as { S: Record<string, { value: number }> };
    expect(Math.abs((data.S['x2']?.value ?? 0) - 0.442411)).toBeLessThan(0.03);
  });
});
