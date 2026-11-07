import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ToolCall } from '../contract';
import type { PhysicsIntent, PlanStep } from './intent';

export interface BuiltModel {
  readonly document: CadDocument;
  readonly analysisId: string;
}

/**
 * The validation plan applied with build_project (the plan's own runner: aliases and `=mesh_h` parameter expressions) on an empty document. Ids are
 * step-scoped, so the live document mints the same ones when the scripted driver sends the same call.
 */
export function buildModel(steps: readonly PlanStep[]): BuiltModel {
  const result = execute(createEmptyDocument(), 'build_project', { actions: steps });
  if (result.rejected === true) throw new Error(`physics plan refused: ${result.summary}`);
  const aliases = (result.data as { aliases?: Record<string, string[]> } | undefined)?.aliases ?? {};
  return { document: result.document, analysisId: aliases['an']?.[0] ?? '' };
}

/**
 * The tool calls a competent analyst makes: set the model up from the validation plan, run the convergence study of the tip probe through the host
 * transport (it re-meshes and re-solves the analysis at every level and records the study against the stored artifacts), then check the verification.
 */
export function physicsScript(intent: PhysicsIntent): ToolCall[] {
  const { document, analysisId } = buildModel(intent.planSteps);
  const probeId = Object.keys(document.analysis?.cases[analysisId]?.probes ?? {})[0] ?? '';
  const quantity = { kind: 'probe', probeId, loadCase: 'LC1' };
  return [
    { tool: 'build_project', args: { actions: intent.planSteps } },
    { tool: 'run_convergence_study', args: { analysisId, quantity, levels: intent.levels, ratio: intent.ratio, timeoutS: 300 } },
    { tool: 'check_verification', args: { analysisId, gciTarget: intent.gciTarget, quantities: [quantity] } },
  ];
}
