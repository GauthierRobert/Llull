/**
 * The live document's binding to its recovery slot (A-08). One autosaver per binding; rebinding flushes the old one first, so the previous
 * document's slot always holds its last state. `bind` is called BEFORE a new document is loaded (open / new), so the load is autosaved
 * into the new slot and never over the previous document's recovery.
 */

import path from 'path';
import type { CadDocument } from '@core/model/types';
import { type AutosaveStatus, createAutosaver } from './autosave';
import { type RecoverySlotMeta, type RecoveryStore, newUntitledSlotId, slotIdForPath, slotLabel } from './recovery';

export interface RecoverySession {
  /** A change to the live document. */
  schedule(doc: CadDocument): void;
  flush(): void;
  /** Flush, then write every later change synchronously (shutdown). */
  stop(): void;
  /**
   * The live document now belongs to `documentPath` (null: untitled). The previous binding's slot is kept unless `dropPrevious` (the user
   * chose to discard it) or it is empty; a stale unrecovered slot already holding the new name is archived, never overwritten.
   */
  bind(documentPath: string | null, dropPrevious: boolean): void;
  /** The live document equals its file (or was discarded): its slot and any pending write go away. */
  markSaved(): void;
  /** Bind to the existing slot `id` (a restored document), dropping the previous binding's slot, and write the live document into it now. */
  adopt(id: string, current: CadDocument): RecoverySlotMeta | null;
  current(): { id: string; path: string | null };
}

interface SessionOptions {
  readonly store: RecoveryStore;
  readonly debounceMs: number;
  readonly serialize: (doc: CadDocument) => string;
  readonly onStatus: (status: AutosaveStatus) => void;
  readonly initial: { id: string; path: string | null };
  readonly now?: () => Date;
}

const isEmpty = (doc: CadDocument): boolean => doc.order.length === 0;

export function createRecoverySession(options: SessionOptions): RecoverySession {
  const { store } = options;
  const now = options.now ?? ((): Date => new Date());
  let binding = options.initial;
  let changeCount = 0;
  let stopped = false;
  let saver = makeSaver();

  function makeSaver(): ReturnType<typeof createAutosaver> {
    const bound = binding;
    const created = createAutosaver({
      filePath: store.docFile(bound.id),
      debounceMs: options.debounceMs,
      serialize: options.serialize,
      onStatus: options.onStatus,
      onWritten: (doc) => {
        if (bound.id !== binding.id) return;
        if (isEmpty(doc)) return store.remove(bound.id); // nothing worth recovering
        store.writeMeta({
          id: bound.id,
          path: bound.path,
          kind: 'document',
          label: slotLabel(bound.path),
          changedAt: now().toISOString(),
          changeCount,
        });
        store.writeActive(bound.id, bound.path);
      },
    });
    if (stopped) created.stop();
    return created;
  }

  const rebind = (next: { id: string; path: string | null }): void => {
    saver.flush();
    binding = next;
    changeCount = 0;
    saver = makeSaver();
    store.writeActive(next.id, next.path);
  };

  return {
    schedule(doc) {
      changeCount += 1;
      saver.schedule(doc);
    },
    flush: () => saver.flush(),
    stop() {
      stopped = true;
      saver.stop();
    },
    bind(documentPath, dropPrevious) {
      const previous = binding;
      const nextId = documentPath === null ? newUntitledSlotId() : slotIdForPath(documentPath);
      const resolved = documentPath === null ? null : path.resolve(documentPath);
      if (nextId === previous.id) return void (binding = { id: nextId, path: resolved });
      saver.flush();
      if (dropPrevious) store.remove(previous.id);
      if (documentPath !== null && store.read(nextId) !== null) store.archive(nextId);
      rebind({ id: nextId, path: resolved });
    },
    markSaved() {
      saver.flush(); // settles an in-flight write (it can no longer land), then the slot goes
      store.remove(binding.id);
      changeCount = 0;
      saver = makeSaver();
    },
    adopt(id, current) {
      const found = store.read(id);
      if (found === null) return null;
      const previous = binding.id;
      saver.flush();
      if (previous !== id) store.remove(previous);
      binding = { id, path: found.meta.path };
      changeCount = found.meta.changeCount;
      saver = makeSaver();
      store.writeActive(id, found.meta.path);
      saver.schedule(current);
      saver.flush(); // durable now: the restored work must survive a crash right after
      return store.read(id)?.meta ?? found.meta;
    },
    current: () => binding,
  };
}
