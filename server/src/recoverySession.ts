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
import {
  type RecoverySlotMeta,
  type RecoveryStore,
  type SlotBase,
  baseFields,
  metaBase,
  newUntitledSlotId,
  slotIdForPath,
  slotLabel,
} from './recovery';

export interface SlotBinding {
  readonly id: string;
  readonly path: string | null;
  /** The document file as opened / last saved (null: untitled, or not known). */
  readonly base: SlotBase | null;
}

export interface RecoverySession {
  /** A change to the live document. */
  schedule(doc: CadDocument): void;
  flush(): void;
  /** Flush, then write every later change synchronously (shutdown). */
  stop(): void;
  /**
   * A document is about to REPLACE the live one: flush the current binding's slot, then keep later changes out of it. Ended by `bind`,
   * `adopt`, `markSaved`, `release`, or the hold TTL (the held changes then go to the current binding, status DSF_HOLD_EXPIRED).
   */
  hold(): void;
  /** The held replacement did not happen: the current binding takes over the changes that arrived meanwhile. */
  release(): void;
  /**
   * The live document now belongs to `documentPath` (null: untitled). The previous binding's slot is kept unless `dropPrevious` (the user
   * chose to discard it); a stale unrecovered slot already holding the new name is archived, never overwritten.
   */
  bind(documentPath: string | null, dropPrevious: boolean, base?: SlotBase | null): void;
  /** The file was saved (or re-read): that is the base of the slot from now on, whether or not the slot is removed. */
  setBase(base: SlotBase | null): void;
  /** The live document equals its file (or was discarded): its slot and any pending write go away. */
  markSaved(): void;
  /**
   * Bind to the existing slot `id` (a restored document) and write the live document into it now. The previous binding's slot is removed when it
   * holds nothing but the restored document, ARCHIVED (offered again by Document Recovery) when it holds different unsaved work.
   */
  adopt(id: string, current: CadDocument): RecoverySlotMeta | null;
  current(): SlotBinding;
}

interface SessionOptions {
  readonly store: RecoveryStore;
  readonly debounceMs: number;
  readonly serialize: (doc: CadDocument) => string;
  readonly onStatus: (status: AutosaveStatus) => void;
  readonly initial: { id: string; path: string | null; base?: SlotBase | null };
  readonly now?: () => Date;
  /** Write `active.json` for `initial` now (a fresh backend), so a resuming restart never loads the previous session's slot. */
  readonly announceActive?: boolean;
  /** A hold nobody ends (a crashed host, a lost request) expires after this long (default 30 s): the held changes go to the current binding. */
  readonly holdTtlMs?: number;
}

const DEFAULT_HOLD_TTL_MS = 30_000;

const isEmpty = (doc: CadDocument): boolean => doc.order.length === 0;

export function createRecoverySession(options: SessionOptions): RecoverySession {
  const { store } = options;
  const now = options.now ?? ((): Date => new Date());
  let binding: SlotBinding = { ...options.initial, base: options.initial.base ?? null };
  let changeCount = 0;
  let stopped = false;
  let held = false;
  let heldDoc: CadDocument | null = null; // the newest change that arrived while held
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const holdTtlMs = options.holdTtlMs ?? DEFAULT_HOLD_TTL_MS;
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
          ...baseFields(binding.base),
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
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    const doc = heldDoc;
    heldDoc = null;
    if (doc === null) return;
    changeCount += 1;
    saver.schedule(doc);
  }

  function expireHold(): void {
    holdTimer = null;
    if (!held) return;
    console.warn('[recovery] a document replacement never finished; its changes go to the current slot');
    if (heldDoc !== null) {
      lastStatus = {
        ok: false,
        code: 'DSF_HOLD_EXPIRED',
        message: 'A document replacement did not finish; its changes were kept in the current slot',
      };
      options.onStatus(lastStatus); // the replayed write reports ok again
    }
    replayHeld();
    saver.flush(); // durable now: nobody is coming to finish the replacement
  }

  /** Shutdown / crash while held: the newest change is written to the current binding rather than lost (it stays held for a later bind). */
  function persistHeld(): void {
    if (!held || heldDoc === null) return;
    changeCount += 1;
    saver.schedule(heldDoc);
  }

  /** Whatever ends a replacement (also an error inside it), the hold ends with it. */
  function endingHold<T>(run: () => T): T {
    try {
      return run();
    } finally {
      if (held) replayHeld();
    }
  }

  const rebind = (next: SlotBinding): void => {
    saver.flush();
    binding = next;
    changeCount = 0;
    saver = makeSaver();
    store.writeActive(next.id, next.path);
    replayHeld();
  };

  function dropHold(): void {
    held = false;
    heldDoc = null;
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  }

  function bindNow(documentPath: string | null, dropPrevious: boolean, base: SlotBase | null): void {
    const previous = binding;
    const nextId = documentPath === null ? newUntitledSlotId() : slotIdForPath(documentPath);
    const resolved = documentPath === null ? null : path.resolve(documentPath);
    if (nextId === previous.id) {
      binding = { id: nextId, path: resolved, base };
      return replayHeld();
    }
    saver.flush();
    if (dropPrevious) {
      store.remove(previous.id);
      if (failedSlot === previous.id) clearFailure();
    }
    if (documentPath !== null && store.read(nextId) !== null) store.archive(nextId);
    rebind({ id: nextId, path: resolved, base });
  }

  function adoptNow(id: string, current: CadDocument): RecoverySlotMeta | null {
    const found = store.read(id);
    if (found === null) return null; // endingHold gives the hold back
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
    dropHold();
    binding = { id, path: found.meta.path, base: metaBase(found.meta) };
    changeCount = found.meta.changeCount;
    saver = makeSaver();
    store.writeActive(id, found.meta.path);
    saver.schedule(current);
    saver.flush(); // durable now: the restored work must survive a crash right after
    return store.read(id)?.meta ?? found.meta;
  }

  return {
    schedule(doc) {
      if (held) {
        heldDoc = doc;
        return;
      }
      changeCount += 1;
      saver.schedule(doc);
      if (!lastStatus.ok && lastStatus.code === 'DSF_HOLD_EXPIRED') clearFailure(); // the warning is shown until the next change
    },
    flush() {
      persistHeld();
      saver.flush();
    },
    stop() {
      persistHeld();
      stopped = true;
      saver.stop();
    },
    hold() {
      saver.flush();
      held = true;
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = setTimeout(expireHold, holdTtlMs);
      holdTimer.unref();
    },
    release: replayHeld,
    bind: (documentPath, dropPrevious, base = null) => endingHold(() => bindNow(documentPath, dropPrevious, base)),
    setBase(base) {
      binding = { ...binding, base };
      const found = store.read(binding.id);
      if (found !== null) store.writeMeta({ ...found.meta, ...baseFields(base) });
    },
    adopt: (id, current) => endingHold(() => adoptNow(id, current)),
    markSaved() {
      saver.flush(); // settles an in-flight write (it can no longer land), then the slot goes
      store.remove(binding.id);
      changeCount = 0;
      dropHold();
      saver = makeSaver();
      if (failedSlot === binding.id) clearFailure(); // the file holds the document: nothing is at risk any more
    },
    current: () => binding,
  };
}
