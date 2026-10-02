/** Tiny, dependency-free unique id generator for entities. */

/** Mints ids for one execution scope. Injected per `execute` via `ExecutionContext.ids`. */
export interface IdSource {
  next(prefix: string): string;
}

let counter = 0;

/** Process-wide default source: time-sortable prefix + counter. */
export const counterIdSource: IdSource = {
  next(prefix: string): string {
    counter += 1;
    // Time component keeps ids sortable-ish; counter guarantees uniqueness in a tick.
    return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
  },
};

let scopedSource: IdSource | null = null;

/**
 * Run `fn` with `source` as the active id source; restores the previous one afterwards.
 * @invariant scopes nest; the outer source is restored even when `fn` throws
 */
export function withIdSource<T>(source: IdSource, fn: () => T): T {
  const previous = scopedSource;
  scopedSource = source;
  try {
    return fn();
  } finally {
    scopedSource = previous;
  }
}

export function nextId(prefix = 'e'): string {
  return (scopedSource ?? counterIdSource).next(prefix);
}

/** Reset — used by tests to get deterministic ids. */
export function __resetIdCounter(): void {
  counter = 0;
}
