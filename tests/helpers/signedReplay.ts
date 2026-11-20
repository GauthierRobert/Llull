/** SIG-REPLAY: the replay seed keeps a signed record only while the step that recorded it is live. One scenario every signed gate's suite runs. */

import { expect } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';

/** The regenerated documents of the scenario, for the suite's own "back to pending" assertions. */
export interface SignedReplayOutcome {
  /** The signing step suppressed, regenerated. */
  readonly suppressed: CadDocument;
  /** The signing step deleted, regenerated. */
  readonly deleted: CadDocument;
  /** Suppressed, then unsuppressed: the replayed step is a no-op, the record stays gone (a human must sign again). */
  readonly restored: CadDocument;
}

/**
 * `signed` = a document whose LAST `command` step recorded the record that `record(doc)` reads (undefined when absent). Asserts the record is stamped
 * with that step's key, is kept by `replay_history`, and is gone after suppressing or deleting that step and after unsuppressing it; none of these fails.
 */
export function expectSignedReplayFollowsHistory(
  signed: CadDocument,
  command: string,
  record: (doc: CadDocument) => { readonly stepKey?: string } | undefined,
  ctx: ExecutionContext,
): SignedReplayOutcome {
  const step = signed.featureHistory.filter((candidate) => candidate.name === command).at(-1);
  expect(step, `no ${command} step`).toBeDefined();
  const stepId = step?.id ?? '';
  expect(record(signed)?.stepKey).toBe(stepId.replace(/^step-/, ''));
  const replayed = execute(signed, 'replay_history', {}, ctx);
  expect(replayed.error, replayed.summary).toBeUndefined();
  expect(record(replayed.document)).toEqual(record(signed));
  const suppressed = execute(signed, 'set_step_suppressed', { stepId, suppressed: true }, ctx);
  expect(suppressed.error, suppressed.summary).toBeUndefined();
  expect(record(suppressed.document)).toBeUndefined();
  const deleted = execute(signed, 'delete_step', { stepId }, ctx);
  expect(deleted.error, deleted.summary).toBeUndefined();
  expect(record(deleted.document)).toBeUndefined();
  const restored = execute(suppressed.document, 'set_step_suppressed', { stepId, suppressed: false }, ctx);
  expect(restored.error, restored.summary).toBeUndefined();
  expect(restored.summary).not.toMatch(/FAILED/);
  expect(record(restored.document)).toBeUndefined();
  return { suppressed: suppressed.document, deleted: deleted.document, restored: restored.document };
}
