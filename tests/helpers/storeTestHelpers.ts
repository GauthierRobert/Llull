/**
 * @layer tests/helpers
 *
 * Test-only store utilities.
 *
 * Component tests that need to pre-populate the store with entities (e.g. to
 * assert rendering behavior) should use `localDispatch` instead of
 * `useStore.getState().dispatch`. The real `dispatch` is now a network call
 * (POST /command); `localDispatch` calls `execute` from core synchronously and
 * pushes the result directly into the store via `hydrateLiveDocument`, which is
 * the same path the SSE stream uses in production.
 *
 * This keeps component tests hermetic (no fetch mocking needed for setup) while
 * fully respecting the PRIME DIRECTIVE: entities are still only built inside
 * `core/commands/execute`, never inline.
 */

import { expect, vi } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { type LiveSnapshotEvent, documentHash } from '@mcp/liveSync';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { useStore } from '@ui/store';

/**
 * Execute a command synchronously against the current store document and
 * apply the result via `hydrateLiveDocument` (the same path as the SSE stream).
 *
 * Returns the CommandResult so callers can read `affected` ids.
 *
 * USE IN TESTS ONLY — not for production code.
 */
export function localDispatch(name: string, params: unknown): CommandResult {
  const doc = useStore.getState().document;
  const result = execute(doc, name, params);
  useStore.getState().hydrateLiveDocument(liveSnapshot(result.document));
  return result;
}

export const TEST_EPOCH = 'test-epoch';

/** Wrap a document as a live snapshot event (live-sync protocol). USE IN TESTS ONLY. */
export function liveSnapshot(document: CadDocument, seq = 0, epoch = TEST_EPOCH): LiveSnapshotEvent {
  return { epoch, seq, stateHash: documentHash(document), document };
}

/** Flush all pending microtasks (multiple promise chain hops). */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => resolve());
}

/** Dispatches `add_box` and checks the undo/redo flags the (mocked) server response set. */
export async function expectUndoRedoFlagsAfterDispatch(canUndo: boolean, canRedo: boolean): Promise<void> {
  useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
  await flushPromises();
  expect(useStore.getState().canUndo).toBe(canUndo);
  expect(useStore.getState().canRedo).toBe(canRedo);
}

export function getState(): ReturnType<typeof useStore.getState> {
  return useStore.getState();
}

/** Replace the store's `dispatch` with a spy so param-gathering UI can be asserted. */
export function spyDispatch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  useStore.setState({ dispatch: spy } as unknown as Parameters<typeof useStore.setState>[0]);
  return spy;
}

/** Offline store with an empty document and no local undo history. */
export function resetOfflineStore(): void {
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({ liveStatus: 'disconnected', localUndoStack: [], localRedoStack: [] });
}

/** Replaces `dispatch` with a spy that answers every call's `onResult` with `result`. */
export function answerDispatch(result: { summary: string; changed: boolean }): void {
  const answer = (_n: string, _p: unknown, options?: { onResult?: (r: unknown) => void }): void => options?.onResult?.(result);
  useStore.setState({ dispatch: vi.fn(answer) } as unknown as Parameters<typeof useStore.setState>[0]);
}
