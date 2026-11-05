/**
 * The live document's binding to its recovery slot (A-08). One autosaver per binding; rebinding flushes the old one first, so the previous
 * document's slot always holds its last state. A document that replaces the live one (open / new / restore) is announced with `hold()` BEFORE
 * it is loaded and finished with `bind` / `adopt` only once the load succeeded: the load is never autosaved into the previous document's
 * slot, and a failed load (`release`) leaves the previous document bound to its own slot, untouched.
 */

import path from 'path';
import { errorMessage } from '@lib/errorMessage';
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
   * A document is about to REPLACE the live one: flush the current binding's slot, then keep later changes out of it. Ended by `bind`,
   * `adopt`, `markSaved` or `release`.
   */
  hold(): void;
  /** The held replacement did not happen: the current binding takes over the changes that arrived meanwhile. */
  release(): void;
  /**
   * The live document now belongs to `documentPath` (null: untitled). The previous binding's slot is kept unless `dropPrevious` (the user
   * chose to discard it); a stale unrecovered slot already holding the new name is archived, never overwritten.
   */
  bind(documentPath: string | null, dropPrevious: boolean): void;
  /** The live document equals its file (or was discarded): its slot and any pending write go away. */
  markSaved(): void;
  /**
   * Bind to the existing slot `id` (a restored document) and write the live document into it now. The previous binding's slot is removed when it
   * holds nothing but the restored document, ARCHIVED (offered again by Document Recovery) when it holds different unsaved work.
   */
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
  /** Write `active.json` for `initial` now (a fresh backend), so a resuming restart never loads the previous session's slot. */
  readonly announceActive?: boolean;
}

const isEmpty = (doc: CadDocument): boolean => doc.order.length === 0;

export function createRecoverySession(options: SessionOptions): RecoverySession {
  const { store } = options;
  const now = options.now ?? ((): Date => new Date());
  let binding = options.initial;
  let changeCount = 0;
  let stopped = false;
  let held = false;
  let heldDoc: CadDocument | null = null; // the newest change that arrived while held
  let lastStatus: AutosaveStatus = { ok: true };
  let failedSlot: string | null = null; // the slot whose write failed and has not succeeded since
  let saver = makeSaver();
  if (options.announceActive === true) {
    try {
      store.writeActive(binding.id, binding.path);
    } catch (error) {
      console.warn(`[recovery] cannot announce the active slot: ${errorMessage(error)}`); // the autosaver reports the same folder failing
    }
  }

  function clearFailure(): void {
    failedSlot = null;
    if (lastStatus.ok) return;
    lastStatus = { ok: true };
    options.onStatus(lastStatus);
  }

  function makeSaver(): ReturnType<typeof createAutosaver> {
    const bound = binding;
    const created = createAutosaver({
      filePath: store.docFile(bound.id),
      debounceMs: options.debounceMs,
      serialize: options.serialize,
      onStatus: (status) => {
        if (status.ok && failedSlot !== null && failedSlot !== bound.id) return; // a kept slot's failure outlives a rebinding
        failedSlot = status.ok ? null : bound.id;
        lastStatus = status;
        options.onStatus(status);
      },
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

  /** Leave the held state; what changed meanwhile goes to the current binding. */
  function replayHeld(): void {
    held = false;
    const doc = heldDoc;
    heldDoc = null;
    if (doc === null) return;
    changeCount += 1;
    saver.schedule(doc);
  }

  const rebind = (next: { id: string; path: string | null }): void => {
    saver.flush();
    binding = next;
    changeCount = 0;
    saver = makeSaver();
    store.writeActive(next.id, next.path);
    replayHeld();
  };

  return {
    schedule(doc) {
      if (held) {
        heldDoc = doc;
        return;
      }
      changeCount += 1;
      saver.schedule(doc);
    },
    flush: () => saver.flush(),
    stop() {
      stopped = true;
      saver.stop();
    },
    hold() {
      saver.flush();
      held = true;
    },
    release: replayHeld,
    bind(documentPath, dropPrevious) {
      const previous = binding;
      const nextId = documentPath === null ? newUntitledSlotId() : slotIdForPath(documentPath);
      const resolved = documentPath === null ? null : path.resolve(documentPath);
      if (nextId === previous.id) {
        binding = { id: nextId, path: resolved };
        return replayHeld();
      }
      saver.flush();
      if (dropPrevious) {
        store.remove(previous.id);
        if (failedSlot === previous.id) clearFailure();
      }
      if (documentPath !== null && store.read(nextId) !== null) store.archive(nextId);
      rebind({ id: nextId, path: resolved });
    },
    markSaved() {
      saver.flush(); // settles an in-flight write (it can no longer land), then the slot goes
      store.remove(binding.id);
      changeCount = 0;
      held = false;
      heldDoc = null;
      saver = makeSaver();
      if (failedSlot === binding.id) clearFailure(); // the file holds the document: nothing is at risk any more
    },
    adopt(id, current) {
      const found = store.read(id);
      if (found === null) return null;
      const previous = binding.id;
      saver.flush();
      if (previous !== id) {
        const kept = store.read(previous);
        if (kept !== null && kept.json !== found.json) store.archive(previous);
        else {
          store.remove(previous);
          if (failedSlot === previous) clearFailure();
        }
      }
      held = false;
      heldDoc = null;
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
