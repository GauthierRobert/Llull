import { useSyncExternalStore } from 'react';
import type { CadDocument } from '@core/model/types';
import { useStore } from './store';

let last: CadDocument | null = null;

function sameExceptSelection(a: CadDocument, b: CadDocument): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key === 'selection' || left[key] === right[key]);
}

function getSnapshot(): CadDocument {
  const current = useStore.getState().document;
  if (last !== null && sameExceptSelection(last, current)) return last;
  last = current;
  return current;
}

/**
 * The document, re-rendering (and changing identity) only when something OTHER than `selection` changes: for heavy
 * derived queries that never read the selection. The returned `selection` may be stale: do not read it.
 */
export function useDocumentWithoutSelection(): CadDocument {
  return useSyncExternalStore(useStore.subscribe, getSnapshot, getSnapshot);
}
