// Runs one read-only command (check_*, flat_pattern, hole_table, select_fastener, get_material …) on the store document and keeps its
// parsed result for display. The result is marked stale once the entities or the aerospace sub-models change (selection does not).

import { useCallback, useState } from 'react';
import type { CadDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';

interface Slices {
  readonly entities: CadDocument['entities'];
  readonly sheetMetal: CadDocument['sheetMetal'] | undefined;
  readonly fasteners: CadDocument['fasteners'] | undefined;
  readonly materials: CadDocument['materials'];
}

interface QueryOutcome<T> {
  readonly view: T | null;
  readonly summary: string;
  readonly source: Slices | null;
}

export interface ReadOnlyQuery<T> {
  readonly view: T | null;
  readonly summary: string;
  readonly stale: boolean;
  run(params: Record<string, unknown>): void;
  clear(): void;
}

const EMPTY = { view: null, summary: '', source: null } as const;

export function useReadOnlyQuery<T>(command: string, parse: (data: unknown) => T | null): ReadOnlyQuery<T> {
  const [outcome, setOutcome] = useState<QueryOutcome<T>>(EMPTY);
  const entities = useStore((s) => s.document.entities);
  const sheetMetal = useStore((s) => s.document.sheetMetal);
  const fasteners = useStore((s) => s.document.fasteners);
  const materials = useStore((s) => s.document.materials);
  const run = useCallback(
    (params: Record<string, unknown>): void => {
      const result = runQuery(command, params);
      setOutcome({ view: parse(result.data), summary: result.summary, source: { entities, sheetMetal, fasteners, materials } });
    },
    [command, parse, entities, sheetMetal, fasteners, materials],
  );
  const clear = useCallback((): void => setOutcome(EMPTY), []);
  const { source } = outcome;
  const stale =
    source !== null &&
    (source.entities !== entities || source.sheetMetal !== sheetMetal || source.fasteners !== fasteners || source.materials !== materials);
  return { view: outcome.view, summary: outcome.summary, stale, run, clear };
}
