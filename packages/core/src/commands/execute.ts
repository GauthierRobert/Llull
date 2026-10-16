/** The engine: the single choke point every surface calls (architecture L1, L5, L8). */

import type { CadDocument, FeatureStep } from '../model/types';
import type { CommandResult, ExecutionContext } from './types';
import { currentContext, runInContext } from './context';
import { getCommand } from './commandTable';
import { kernelUnavailable } from './kernelRefusal';
import { commandError, rejection, unknownCommandError } from './noop';
import { stepIdSource } from '../lib/id';

/**
 * @invariant a mutating command (not `readOnly` / `metaHistory`) that changes the document appends FeatureStep `step-<n>` (n =
 *   doc.nextStepNumber) and mints ids `<prefix>-<n>.<k>`, so replay re-mints identical ids; an execute nested inside a running step joins
 *   it (no extra step)
 * @failure nextStepNumber not a safe integer >= 1 (a mutating command would re-mint ids), unknown command, or `requiresKernel` while ctx.kernel is null -> no-op, affected:[], rejected:true
 */
export function execute(doc: CadDocument, commandName: string, params: unknown, ctx: ExecutionContext = currentContext()): CommandResult {
  const def = getCommand(commandName);
  if (!def) return rejection(doc, `Unknown command: ${commandName}`, unknownCommandError());
  const annotations = def.annotations;
  if (annotations?.requiresKernel === true && ctx.kernel === null)
    return rejection(
      doc,
      kernelUnavailable(commandName),
      commandError('CMD_KERNEL_UNAVAILABLE', 'Retry once the geometry kernel has loaded, or run with `--kernel occt`.'),
    );
  const recordsStep = annotations?.readOnly !== true && annotations?.metaHistory !== true;
  if (!recordsStep || ctx.stepKey !== undefined) {
    // Queries, history meta-commands, and executes nested inside a running step append nothing.
    return runInContext(ctx, () => def.run(doc, params, ctx));
  }
  const stepNumber = doc.nextStepNumber ?? 1;
  if (!Number.isSafeInteger(stepNumber) || stepNumber < 1)
    return rejection(
      doc,
      `${commandName} rejected: document nextStepNumber ${String(stepNumber)} is not a safe integer >= 1 (ids would collide).`,
      commandError(
        'CMD_STEP_COUNTER_INVALID',
        'Reload the document from a valid file; its step counter is corrupt.',
        [],
        ['nextStepNumber'],
      ),
    );
  const stepKey = String(stepNumber);
  const stepContext: ExecutionContext = { ...ctx, ids: stepIdSource(stepKey), stepKey };
  const result = runInContext(stepContext, () => def.run(doc, params, stepContext));
  if (result.document === doc) return result;
  const step: FeatureStep = { id: `step-${stepKey}`, name: commandName, params, suppressed: false, affected: result.affected };
  return {
    ...result,
    document: {
      ...result.document,
      featureHistory: [...result.document.featureHistory, step],
      nextStepNumber: Math.max(result.document.nextStepNumber ?? 1, stepNumber + 1),
    },
  };
}
