/** @layer ui/store Narrow selection selectors shared by panels (and reusable by the viewport). */

import { useMemo } from 'react';
import type { Entity } from '@core/model/types';
import { useStore } from './store';

/** The selected entity ids as a set (rebuilt only when the selection changes). */
export function useSelectionSet(): ReadonlySet<string> {
  const selection = useStore((s) => s.document.selection);
  return useMemo(() => new Set(selection), [selection]);
}

/** The selected entity when exactly one entity is selected, else undefined. */
export function useSoleSelectedEntity(): Entity | undefined {
  const selectedId = useStore((s) => (s.document.selection.length === 1 ? s.document.selection[0] : undefined));
  return useStore((s) => (selectedId === undefined ? undefined : s.document.entities[selectedId]));
}
