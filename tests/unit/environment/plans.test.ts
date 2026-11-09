import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

const PLANS = path.resolve(__dirname, '../../../docs/physics/14-moisture-outgassing/validation/plans');

interface PlanResult {
  ok: boolean;
  steps: { index: number; command: string; ok: boolean; summary: string }[];
}

/** Runs a validation-pack plan (steps `{ command, params, as? }`) as a build_project on an empty document. */
function runPlan(file: string): { result: ReturnType<typeof execute>; steps: PlanResult['steps'] } {
  const actions = JSON.parse(readFileSync(path.join(PLANS, file), 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  return { result, steps: (result.data as PlanResult).steps };
}

describe('PHY-14 validation plans run end to end (AF-23 harness)', () => {
  it.each(['moisture_uptake_proposed.json', 'ao_erosion_proposed.json', 'outgassing_check_proposed.json'])(
    '%s: every step succeeds',
    (file) => {
      const { steps } = runPlan(file);
      expect(steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
      expect(steps.length).toBeGreaterThan(0);
    },
  );

  it('the outgassing plan builds the mission environment and a 200 g panel that passes the NASA profile', () => {
    const { result, steps } = runPlan('outgassing_check_proposed.json');
    expect(result.document.spaceEnvironment?.outgassingProfile).toBe('nasa_gsfc_screening');
    const last = steps[steps.length - 1];
    expect(last?.command).toBe('check_space_environment');
    expect(last?.summary).toContain('PASS');
    expect(last?.summary).toContain('max mass loss 1.90000 g');
    expect(last?.summary).toContain('max condensables 0.100000 g');
  });
});
