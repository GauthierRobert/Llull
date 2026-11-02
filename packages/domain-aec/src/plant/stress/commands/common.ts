/** Helpers shared by the stress commands. */

import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { AnalysisFailure } from '../analysis';
import { refuse } from '../codes';
import type { StressModel } from '../model/schema';
import { findModel, getStress } from '../model/store';

/** The model, or the PST_MODEL_NOT_FOUND refusal naming the models that exist. */
export function modelOr(doc: CadDocument, command: string, modelId: string): StressModel | CommandResult {
  const model = findModel(doc, modelId);
  return (
    model ??
    refuse(
      doc,
      command,
      'PST_MODEL_NOT_FOUND',
      `no stress model "${modelId}" (models: ${getStress(doc).modelOrder.join(', ') || 'none'})`,
      [modelId],
      ['modelId'],
    )
  );
}

export const isRefusal = (value: StressModel | CommandResult): value is CommandResult => 'document' in value;

/** A failed analysis as a coded refusal of `command`. */
export const analysisRefusal = (doc: CadDocument, command: string, failure: AnalysisFailure): CommandResult =>
  refuse(doc, command, failure.code, failure.message, failure.ids, failure.paths);
