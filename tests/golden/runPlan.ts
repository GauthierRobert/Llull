import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { GoldenAction } from './plans';

interface PlanOutcome {
  document: CadDocument;
  affected: string[];
  failedSteps: string[];
}

interface StepData {
  ok: boolean;
  steps: { index: number; command: string; ok: boolean; summary: string }[];
}

export function runPlan(actions: GoldenAction[]): PlanOutcome {
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const data = result.data as StepData;
  const failedSteps = data.steps
    .filter((s) => !s.ok)
    .map((s) => `#${s.index} ${s.command}: ${s.summary}`);
  if (!data.ok && failedSteps.length === 0) failedSteps.push(result.summary);
  return { document: result.document, affected: result.affected, failedSteps };
}
