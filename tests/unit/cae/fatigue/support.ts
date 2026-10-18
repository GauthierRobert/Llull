import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const REPO = path.resolve(__dirname, '../../../..');

interface PlanStep {
  readonly ok: boolean;
  readonly command: string;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
  readonly affected: string[];
}

export interface PlanRun {
  readonly document: CadDocument;
  readonly steps: PlanStep[];
  readonly aliases: Record<string, string[]>;
}

/** Runs a validation-pack plan file through build_project on a fresh document (onError continue so failures show per step). */
export function runPlanFile(relative: string, upTo?: string): PlanRun {
  const plan = JSON.parse(readFileSync(path.join(REPO, relative), 'utf8')) as Array<{ command: string }>;
  const stop = upTo === undefined ? plan.length : plan.findIndex((step) => step.command === upTo) + 1;
  const result = execute(createEmptyDocument(), 'build_project', { actions: plan.slice(0, stop), onError: 'continue' });
  const data = result.data as { steps: PlanStep[]; aliases?: Record<string, string[]> };
  return { document: result.document, steps: data.steps, aliases: data.aliases ?? {} };
}

export const stepData = (run: PlanRun, command: string): Record<string, unknown> => {
  const found = run.steps.find((step) => step.command === command);
  return found?.data ?? {};
};

const MP = 'docs/physics';
export const FAT_PLANS = `${MP}/07-fatigue/validation/plans`;
export const FRC_PLANS = `${MP}/08-fracture-damage-tolerance/validation/plans`;

/** The document after the steps of a plan that come BEFORE the first `command` step (materials and models, no case yet). */
export function runPlanBefore(relative: string, command: string): PlanRun {
  const plan = JSON.parse(readFileSync(path.join(REPO, relative), 'utf8')) as Array<{ command: string }>;
  const stop = plan.findIndex((step) => step.command === command);
  const result = execute(createEmptyDocument(), 'build_project', { actions: plan.slice(0, stop), onError: 'abort' });
  const data = result.data as { steps: PlanStep[]; aliases?: Record<string, string[]> };
  return { document: result.document, steps: data.steps, aliases: data.aliases ?? {} };
}

interface ExpectedCase {
  readonly id: string;
  readonly value: unknown;
}
/** `value` of case `id` in a pack's expected_results.json. */
export function expectedValue(pack: string, id: string): unknown {
  const file = JSON.parse(readFileSync(path.join(REPO, 'docs/physics', pack, 'validation/expected_results.json'), 'utf8')) as {
    cases: ExpectedCase[];
  };
  const found = file.cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no case ${id} in ${pack}`);
  return found.value;
}

export const relativeError = (actual: number, expected: number): number => Math.abs(actual / expected - 1);
