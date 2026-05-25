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
  useStore.getState().hydrateLiveDocument(result.document);
  return result;
}
