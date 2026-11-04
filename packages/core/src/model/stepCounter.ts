import type { CadDocument } from './types';

/**
 * History restore (undo/redo) must not rewind the step counter, or undone ids would be re-minted.
 * @invariant result.nextStepNumber = max(current, restored); `restored` is returned as-is when it already holds the maximum; a restored document without a uid keeps the current one (the identity never rewinds)
 */
export function withMonotonicStepCounter(restored: CadDocument, current: CadDocument): CadDocument {
  const nextStepNumber = Math.max(current.nextStepNumber ?? 1, restored.nextStepNumber ?? 1);
  const uid = restored.uid ?? current.uid;
  return restored.nextStepNumber === nextStepNumber && restored.uid === uid
    ? restored
    : { ...restored, nextStepNumber, ...(uid !== undefined ? { uid } : {}) };
}
