/** The engine: the single choke point every surface calls (architecture L1, L5, L8). */

import type { CadDocument, FeatureStep } from '../model/types';
import type { CommandResult, ExecutionContext } from './types';
import { currentContext, runInContext } from './context';
import { getCommand } from './commandTable';
import { kernelUnavailable } from './kernelRefusal';
import { commandError, rejection, unknownCommandError } from './noop';
import { stepIdSource } from '../lib/id';
import type { GeometryKernel } from '../geometry/kernel';
import { blobText } from '../model/blobs';

const blobsGiven = new WeakMap<GeometryKernel, Set<string>>();

/** Hand `kernel` every B-rep blob of `doc` it has not been given yet, so `brep` recipe leaves evaluate (TR-KRN-21). */
function feedBlobs(doc: CadDocument, kernel: GeometryKernel | null): void {
  if (kernel === null || kernel.loadBlob === undefined || doc.blobs === undefined) return;
  let given = blobsGiven.get(kernel);
  if (given === undefined) blobsGiven.set(kernel, (given = new Set()));
  for (const [sha256, blob] of Object.entries(doc.blobs)) {
    if (given.has(sha256) || blob.mediaType !== 'model/x-occt-brep') continue;
    const text = blobText(blob);
    if (text === null) continue;
    kernel.loadBlob(sha256, text);
    given.add(sha256);
  }
}

/**
 * Step params without a human signature (TR-MAT-51): the signature is checked by the command and never stored in the history or the saved file.
 * @invariant a `confirmation` object is replaced by `{ verified: true }`; params without one are returned as given
 */
function withoutConfirmation(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return params;
  const confirmation: unknown = (params as Record<string, unknown>)['confirmation'];
  return typeof confirmation === 'object' && confirmation !== null ? { ...params, confirmation: { verified: true } } : params;
}

/**
 * @invariant a mutating command (not `readOnly` / `metaHistory` / `session`) that changes the document appends FeatureStep `step-<n>` (n =
 *   doc.nextStepNumber) and mints ids `<prefix>-<n>.<k>`, so replay re-mints identical ids; an execute nested inside a running step joins
 *   it (no extra step)
 * @invariant before any command runs, the kernel is given every document B-rep blob it has not seen (`GeometryKernel.loadBlob`)
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
  feedBlobs(doc, ctx.kernel);
  const recordsStep = annotations?.readOnly !== true && annotations?.metaHistory !== true && annotations?.session !== true;
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
  const step: FeatureStep = {
    id: `step-${stepKey}`,
    name: commandName,
    params: withoutConfirmation(params),
    suppressed: false,
    affected: result.affected,
  };
  return {
    ...result,
    document: {
      ...result.document,
      featureHistory: [...result.document.featureHistory, step],
      nextStepNumber: Math.max(result.document.nextStepNumber ?? 1, stepNumber + 1),
    },
  };
}
