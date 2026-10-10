/**
 * @layer ui/hooks
 *
 * useAutosave — debounced autosave of the working document, restore at startup, and the
 * unsaved-changes tracking behind the `beforeunload` warning and the TopBar indicator.
 *
 * - Saves 1.5 s after the last change and on `pagehide` / `visibilitychange` (hidden).
 * - Restore happens once, when the live-server connection attempt fails (offline / local mode) and
 *   the document is empty: `dispatch('load_document')` (PRIME DIRECTIVE), `localOnly` so a later
 *   outbox flush never replaces the shared server document with it. When a live server is
 *   connected the server document is the truth: nothing is restored, saved or marked unsaved.
 */

import { useEffect } from 'react';
import { serializeDocument } from '@core/commands/persistence';
import { useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import type { KeyValueStorage } from '@ui/store/autosave';
import { browserStorage, clearAutosave, readAutosave, writeAutosave } from '@ui/store/autosave';

export const AUTOSAVE_DELAY_MS = 1500;

export function useAutosave(storage: KeyValueStorage | null = browserStorage()): void {
  useEffect(() => {
    let restoreDecided = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const state = useStore.getState();
      if (storage === null || !restoreDecided || !pending || state.liveStatus === 'connected')
        return;
      pending = false;
      if (state.document.order.length === 0) clearAutosave(storage);
      else {
        const clean = !useSessionStore.getState().dirty;
        writeAutosave(storage, {
          savedAt: Date.now(),
          json: serializeDocument(state.document),
          ...(clean ? { clean: true } : {}),
        });
      }
    };

    const restoreOnce = (): void => {
      if (restoreDecided) return;
      restoreDecided = true;
      const state = useStore.getState();
      if (storage === null || state.liveStatus === 'connected') return;
      const record = readAutosave(storage);
      if (record === null || state.document.order.length > 0) return;
      state.dispatch(
        'load_document',
        { json: record.json },
        {
          quiet: true,
          localOnly: true,
          onResult: ({ changed }) => {
            if (!changed) {
              console.warn('llull: autosave could not be restored; discarding it');
              clearAutosave(storage);
              return;
            }
            if (record.clean === true) {
              // Identical to the last saved file: nothing unsaved to announce.
              useSessionStore.getState().markSaved();
            } else {
              useSessionStore.getState().setRestoredAt(record.savedAt);
            }
          },
        },
      );
    };

    const initialStatus = useStore.getState().liveStatus;
    if (initialStatus !== 'connecting') restoreOnce();

    const unsubscribe = useStore.subscribe((state, previous) => {
      if (!restoreDecided && state.liveStatus !== 'connecting') restoreOnce();
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
