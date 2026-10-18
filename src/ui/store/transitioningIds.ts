import { useMemo } from 'react';
import type { EntityId } from '@core/model/types';
import { useLiveFxStore } from './liveFxStore';

const SEPARATOR = '\u0000';

/** Ids mid live-transition; the Set keeps its identity until MEMBERSHIP changes (not on record swaps or unrelated fx). */
export function useTransitioningIds(): ReadonlySet<EntityId> {
  const key = useLiveFxStore((s) => (s.transitions.size === 0 ? '' : [...s.transitions.keys()].sort().join(SEPARATOR)));
  return useMemo(() => new Set(key === '' ? [] : key.split(SEPARATOR)), [key]);
}
