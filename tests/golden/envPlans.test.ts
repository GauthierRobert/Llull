/**
 * Golden pin of the PHY-14 end-to-end plan (docs/physics/14-moisture-outgassing/validation/plans/env_mission_end_to_end.plan.json): materials with
 * E595 data (testMethod ASTM_E595) and moisture / AO properties, two parts, the mission environment, moisture_uptake, hygro_strain, ao_erosion and
 * check_space_environment under the NASA (E595) and the ECSS profile (ENV_TEST_METHOD_MISMATCH). The normalized document and the query data are
 * pinned; the numbers are tied to VC-ENV-04, 05, 07 and 08; replay is identical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { close, pinned } from '../unit/environment/fixtures';
import { normalize, normalizeGeometry } from './normalize';

interface Step {
  command: string;
  ok: boolean;
  summary: string;
  data?: unknown;
}

const PLAN = 'docs/physics/14-moisture-outgassing/validation/plans/env_mission_end_to_end.plan.json';

function run(): { steps: Step[]; document: ReturnType<typeof createEmptyDocument> } {
  const actions = JSON.parse(readFileSync(PLAN, 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const data = result.data as { steps: Step[] };
  expect(data.steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { steps: data.steps, document: result.document };
}

const dataOf = (steps: Step[], command: string): unknown[] => steps.filter((step) => step.command === command).map((step) => step.data);

interface CheckData {
  status: string;
  findings: { code: string; entityIds?: string[] }[];
  budget: { totalMassLossG: number; totalCondensableG: number };
  moisture?: { items: { status: string; moisturePercent: number | null; waterUptakeG: number | null }[] };
  ao?: { items: { material: string; recessionUm: number | null }[] };
}

describe('PHY-14 env_mission_end_to_end plan, golden', () => {
  it('screens outgassing, moisture per part and AO, flags the test-method mismatch under ECSS; replay is identical', () => {
    const plan = run();
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const [uptake] = dataOf(plan.steps, 'moisture_uptake') as { moisturePercent: number }[];
    expect(close(uptake?.moisturePercent ?? NaN, (pinned('VC-ENV-04') as { moisturePercent: number }).moisturePercent)).toBe(true);
    const [strain] = dataOf(plan.steps, 'hygro_strain') as { equivalentDeltaT: { value: number } }[];
    expect(close(strain?.equivalentDeltaT.value ?? NaN, (pinned('VC-ENV-05') as { equivalentDeltaTK: number }).equivalentDeltaTK)).toBe(
      true,
    );
    const [nasa, ecss] = dataOf(plan.steps, 'check_space_environment') as CheckData[];
    expect(nasa?.status).toBe('pass');
    expect(close(nasa?.budget.totalMassLossG ?? NaN, 1.9 + 0.0001 * 2.16)).toBe(true);
    expect(nasa?.moisture?.items.map((item) => item.status)).toEqual(['info', 'unknown']);
    expect(nasa?.moisture?.items[0]?.moisturePercent).toBe(uptake?.moisturePercent);
    expect(close(nasa?.ao?.items.find((item) => item.material === 'syn_adhesive')?.recessionUm ?? NaN, 30)).toBe(true);
    expect(nasa?.findings.some((finding) => finding.code === 'ENV_TEST_METHOD_MISMATCH')).toBe(false);
    expect(ecss?.findings.filter((finding) => finding.code === 'ENV_TEST_METHOD_MISMATCH')).toHaveLength(1);
    expect(nasa).toMatchSnapshot('check_space_environment nasa');
    expect(ecss).toMatchSnapshot('check_space_environment ecss');
    const again = run();
    expect(again.document).toEqual(plan.document);
    expect(JSON.stringify(again.steps)).toBe(JSON.stringify(plan.steps));
    const replayed = execute(plan.document, 'replay_history', {});
    expect(normalizeGeometry(replayed.document)).toEqual(normalizeGeometry(plan.document));
  });
});
