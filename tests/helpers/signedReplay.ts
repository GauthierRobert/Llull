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
 * with that step's key, is kept by `replay_history` and through a squash of that step, and is gone after suppressing or deleting that step and after
 * unsuppressing it; none of these fails.
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
  expect(restored.summary).toContain('stay pending until a human signs again');
  expect(restored.summary).not.toContain('no longer change the document');
  expect((restored.data as { notReapplied?: unknown } | undefined)?.notReapplied).toEqual([stepId]);
  expect(record(restored.document)).toBeUndefined();
  expectSquashKeepsRecord(signed, stepId, record, ctx);
  return { suppressed: suppressed.document, deleted: deleted.document, restored: restored.document };
}

/**
 * Squash: an id-free step is inserted just before the signing step, then both are merged (the merged step keeps the INSERTED step's id). The record,
 * stamped by the signing step, stays live through squash's own verification replay and later replays (`mergedStepKeys`); suppressing the merged step drops it.
 */
function expectSquashKeepsRecord(
  signed: CadDocument,
  stepId: string,
  record: (doc: CadDocument) => { readonly stepKey?: string } | undefined,
  ctx: ExecutionContext,
): void {
  const index = signed.featureHistory.findIndex((candidate) => candidate.id === stepId);
  const previous = signed.featureHistory[index - 1];
  expect(previous, 'the signing step needs a step before it').toBeDefined();
  const inserted = execute(
    signed,
    'insert_step',
    { afterStepId: previous?.id ?? '', name: 'set_modeling_tolerance', params: { maxImportTolerance: 0.5 } },
    ctx,
  );
  expect(inserted.error, inserted.summary).toBeUndefined();
  expect(record(inserted.document)).toEqual(record(signed));
  const fromStepId = inserted.document.featureHistory[index]?.id ?? '';
  const squashed = execute(inserted.document, 'squash_steps', { fromStepId, toStepId: stepId }, ctx);
  expect(squashed.summary).toContain('merged into');
  expect(squashed.document.featureHistory.find((step) => step.id === fromStepId)?.mergedStepKeys).toContain(stepId.replace(/^step-/, ''));
  const replayed = execute(squashed.document, 'replay_history', {}, ctx);
  expect(replayed.error, replayed.summary).toBeUndefined();
  expect(record(replayed.document)).toEqual(record(signed));
  const suppressed = execute(squashed.document, 'set_step_suppressed', { stepId: fromStepId, suppressed: true }, ctx);
  expect(suppressed.error, suppressed.summary).toBeUndefined();
  expect(record(suppressed.document)).toBeUndefined();
}
