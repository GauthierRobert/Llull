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

/**
 * Ids for one feature-history step: `<prefix>-<stepKey>.<n>` (n = mint order within the step).
 * Replaying the step with the same key re-mints the same ids (no id remapping needed).
 */
export function stepIdSource(stepKey: string): IdSource {
  let minted = 0;
  return {
    next(prefix: string): string {
      minted += 1;
      return `${prefix}-${stepKey}.${minted}`;
    },
  };
}

/** Key of a step id: `step-12` → `12`; legacy ids keep their full text as the key. */
export function stepKeyOf(stepId: string): string {
  return stepId.startsWith('step-') ? stepId.slice('step-'.length) : stepId;
}

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

/**
 * Globally unique id (time + process counter), NOT replay-stable. Only for identities that must
 * differ across documents (e.g. the IFC GlobalId salt) and are carried through replay as data.
 */
export function uniqueId(prefix: string): string {
  return counterIdSource.next(prefix);
}
