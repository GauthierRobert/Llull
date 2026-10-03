/**
 * Run a command through `execute` but record different params in the FeatureStep it appends —
 * used to keep parameter-driven `=expr` strings in featureHistory while the command itself
 * receives resolved numbers (architecture L8).
 *
 * @layer core/commands
 * @pure
 */

import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';
import { execute } from './registry';

/**
 * @invariant when `execute` appended exactly one step FOR `command`, its `params` become
 *   `recordedParams`; otherwise (query, no-op, meta-history command such as insert_step, which
 *   appends a step for another command) the result is returned untouched.
 */
export function executeRecorded(
  doc: CadDocument,
  command: string,
  params: unknown,
  recordedParams: unknown,
): CommandResult {
  const result = execute(doc, command, params);
  const history = result.document.featureHistory;
  const appended = history.length === doc.featureHistory.length + 1 ? history.at(-1) : undefined;
  // Only the step this command recorded for itself: a history meta-command (insert_step) appends
  // a step for ANOTHER command, whose params must stay as given.
  if (appended === undefined || appended.name !== command) return result;
  return {
    ...result,
    document: {
      ...result.document,
      featureHistory: [...history.slice(0, -1), { ...appended, params: recordedParams }],
    },
  };
}
