/**
 * Memo of derivation results (02 RTE §13.7). A derivation reads only `plant.piping.{runs, lines, tieIns}`, `plant.spec`, `plant.catalog` and `building` (nozzle
 * ports) of the document, never `entities`, `layers`, `units` or the run order, so results are keyed on those six slices plus the run object: the memo keeps
 * hitting across the documents a command builds step by step (`withRunEntities` makes a new document per run but leaves the slices alone), and retention is
 * bounded by the slices alive, not by every document. Results are deep-frozen copies, so no caller can alter what the next one reads.
 * @invariant a stored value is immutable and shares nothing with the document
 */

import type { CadDocument } from '@core/model/types';
import type { PipeRun } from '@aec/plant/types';

const ABSENT: object = Object.freeze({});

/** An immutable deep copy of plain data (arrays, objects, primitives): frozen all the way down, sharing nothing with `value`. */
export function frozenCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item: unknown) => frozenCopy(item))) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = frozenCopy(item);
  return Object.freeze(copy) as T;
}

/** The slices of `doc` a derivation depends on. */
const slicesOf = (doc: CadDocument): readonly object[] => {
  const { plant } = doc;
  const piping = plant?.piping;
  return [
    piping?.runs ?? ABSENT,
    piping?.lines ?? ABSENT,
    piping?.tieIns ?? ABSENT,
    plant?.spec ?? ABSENT,
    plant?.catalog ?? ABSENT,
    doc.building ?? ABSENT,
  ];
};

export class DerivationMemo<V> {
  private readonly root = new WeakMap<object, unknown>();

  private table(doc: CadDocument, create: boolean): Map<PipeRun, V> | undefined {
    let node = this.root;
    const keys = slicesOf(doc);
    for (const key of keys.slice(0, -1)) {
      let next = node.get(key) as WeakMap<object, unknown> | undefined;
      if (next === undefined) {
        if (!create) return undefined;
        next = new WeakMap<object, unknown>();
        node.set(key, next);
      }
      node = next;
    }
    const last = keys.at(-1) as object;
    let table = node.get(last) as Map<PipeRun, V> | undefined;
    if (table === undefined && create) {
      table = new Map<PipeRun, V>();
      node.set(last, table);
    }
    return table;
  }

  get(doc: CadDocument, run: PipeRun): V | undefined {
    return this.table(doc, false)?.get(run);
  }

  /** Stores a frozen copy of `value` and returns it. */
  set(doc: CadDocument, run: PipeRun, value: V): V {
    const stored = frozenCopy(value);
    (this.table(doc, true) as Map<PipeRun, V>).set(run, stored);
    return stored;
  }
}
