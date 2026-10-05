import type { CadDocument } from './types';

/**
 * History restore (undo/redo) must not rewind the step counter, or undone ids would be re-minted.
 * @pure
 * @invariant result.nextStepNumber = max(current, restored); `restored` is returned as-is when it
 * already holds the maximum
 */
export function withMonotonicStepCounter(restored: CadDocument, current: CadDocument): CadDocument {
  const nextStepNumber = Math.max(current.nextStepNumber ?? 1, restored.nextStepNumber ?? 1);
  return restored.nextStepNumber === nextStepNumber ? restored : { ...restored, nextStepNumber };
}
