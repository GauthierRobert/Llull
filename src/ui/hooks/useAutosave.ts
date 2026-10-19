/**
 * Debounced autosave (1.5 s, and on pagehide / hidden), startup restore and unsaved-changes tracking (beforeunload,
 * TopBar). Restore runs once the connection attempt is decided (failed, or connected AND first snapshot hydrated) with an empty document (`load_document`, run locally;
 * the backend's snapshot replaces it once it connects). With a live server (or an already edited document) an unsaved
 * record that differs is NOT applied: it becomes `pendingLocalCopy` (RestoredBanner) and is never overwritten until chosen.
 * With a live server nothing is saved/marked. A failed write clears the record and shows a status message.
 */

import { useEffect } from 'react';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { type KeyValueStorage, browserStorage, clearAutosave, readAutosave, writeAutosave } from '@ui/store/autosave';

export const AUTOSAVE_DELAY_MS = 1500;
const AUTOSAVE_UNAVAILABLE = 'Autosave unavailable — save to file';
const AUTOSAVE_PAUSED = 'Autosave paused — restore or discard the unsaved local copy first';

/** The restore decision needs the server document (first snapshot) when connected; offline it can run at once. */
function restoreDecidable(state: { liveStatus: string; liveSeq: number }): boolean {
  return state.liveStatus === 'disconnected' || (state.liveStatus === 'connected' && state.liveSeq >= 0);
}

export function useAutosave(storage: KeyValueStorage | null = browserStorage()): void {
  useEffect(() => {
    let restoreDecided = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const state = useStore.getState();
      if (storage === null || !restoreDecided || !pending || state.liveStatus === 'connected') return;
      // Never overwrite the previous session's unrestored work before the user has chosen.
      if (useSessionStore.getState().pendingLocalCopy !== null) {
        state.setStatusMessage(AUTOSAVE_PAUSED);
        return;
      }
      pending = false;
      if (state.document.order.length === 0) clearAutosave(storage);
      else {
        const clean = !useSessionStore.getState().dirty;
        const record = { savedAt: Date.now(), json: serializeDocument(state.document), ...(clean ? { clean: true as const } : {}) };
        if (!writeAutosave(storage, record)) {
          // A stale copy must never be restored as if it were current.
          clearAutosave(storage);
          state.setStatusMessage(AUTOSAVE_UNAVAILABLE);
        }
      }
    };

    const restoreOnce = (): void => {
      if (restoreDecided) return;
      restoreDecided = true;
      const state = useStore.getState();
      if (storage === null) return;
      const record = readAutosave(storage);
      if (record === null) return;
      if (state.liveStatus === 'connected' || state.document.order.length > 0) {
        // Not applied automatically: offer unsaved work that differs from the current document.
        if (record.clean !== true && record.json !== serializeDocument(state.document)) {
          useSessionStore.getState().setPendingLocalCopy({ savedAt: record.savedAt, json: record.json });
        }
        return;
      }
      state.dispatch(
        'load_document',
        { json: record.json },
        {
          quiet: true,
          onResult: ({ changed }) => {
            if (!changed) {
              console.warn('llull: autosave could not be restored; discarding it');
              clearAutosave(storage);
              return;
            }
            if (record.clean === true) {
              // Identical to the last saved file.
              useSessionStore.getState().markSaved();
            } else {
              useSessionStore.getState().setRestoredAt(record.savedAt);
            }
          },
        },
      );
    };

    if (restoreDecidable(useStore.getState())) restoreOnce();

    const unsubscribe = useStore.subscribe((state, previous) => {
      if (!restoreDecided && restoreDecidable(state)) restoreOnce();
      const changed =
        state.document.entities !== previous.document.entities ||
        state.document.building !== previous.document.building ||
        state.document.featureHistory !== previous.document.featureHistory;
      if (!changed || state.liveStatus === 'connected') return;
      useSessionStore.getState().markDirty();
      pending = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, AUTOSAVE_DELAY_MS);
    });

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!useSessionStore.getState().dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [storage]);
}
