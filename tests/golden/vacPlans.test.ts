/**
 * Golden pin of the PHY-20 validation plan (docs/physics/20-vibroacoustics/validation/plans): spectrum -> report -> octave regrouping -> exposure on a box face ->
 * check. The normalized document and the report / check data are pinned; the numbers are tied to VC-VAC-06 and VC-VAC-09; replay is identical. No kernel is
 * installed, so the check cannot verify the faces and says `unknown` (never pass).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectedNumbers, withinCase } from '../unit/vibroacoustics/fixtures';
import { normalize } from './normalize';

interface Step {
  command: string;
  ok: boolean;
  summary: string;
  data?: unknown;
}

const PLAN = 'docs/physics/20-vibroacoustics/validation/plans/vac_flat_spectrum_handoff.plan.json';

function run(): { steps: Step[]; document: ReturnType<typeof createEmptyDocument> } {
  const actions = JSON.parse(readFileSync(PLAN, 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const data = result.data as { steps: Step[] };
  expect(data.steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return { steps: data.steps, document: result.document };
}

const stepsOf = (steps: Step[], command: string): Step[] => steps.filter((step) => step.command === command);

describe('PHY-20 vac_flat_spectrum_handoff plan, golden', () => {
  it('reproduces VC-VAC-06 / 09, records the exposure and reports the handoff unknown without a kernel; replay is identical', () => {
    const plan = run();
    expect(normalize(plan.document)).toMatchSnapshot('document');
    const [thirds, octaves] = stepsOf(plan.steps, 'acoustic_spectrum_report').map(
      (step) => step.data as { oasplDb: number; pRmsPa: number },
    );
    expect(withinCase(thirds?.oasplDb ?? 0, expectedNumbers('VC-VAC-06')[0] ?? 0, 'VC-VAC-06')).toBe(true);
    expect(withinCase(thirds?.pRmsPa ?? 0, expectedNumbers('VC-VAC-09')[0] ?? 0, 'VC-VAC-09')).toBe(true);
    expect(octaves?.oasplDb).toBeCloseTo(thirds?.oasplDb ?? 0, 9);
    const exposure = plan.document.vibroacoustics?.exposures['enclosure_skin'];
    expect(exposure).toMatchObject({ spectrum: 'flat130', field: 'diffuse' });
    const check = stepsOf(plan.steps, 'check_acoustic_handoff')[0]?.data;
    expect(check).toMatchObject({ status: 'unknown', exposures: 1, reviewRequired: true });
    expect(check).toMatchSnapshot('check_acoustic_handoff');
    const again = run();
    expect(again.document).toEqual(plan.document);
    expect(JSON.stringify(again.steps)).toBe(JSON.stringify(plan.steps));
  });
});
