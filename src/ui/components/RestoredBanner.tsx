// "Restored from autosave" banner with "Start fresh" (dispatches `clear_document`, drops the autosave), and the
// "Restore local copy" / "Discard" choice for unsaved work from a previous session that was not applied automatically.

import React, { useEffect } from 'react';
import { useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { browserStorage, clearAutosave } from '@ui/store/autosave';
import { IconButton } from '@ui/panels/PanelParts';

/** The notice hides itself after this long; the restored work stays. */
const AUTO_DISMISS_MS = 20_000;

export function RestoredBanner(): React.ReactElement | null {
  const restoredAt = useSessionStore((s) => s.restoredAt);
  const setRestoredAt = useSessionStore((s) => s.setRestoredAt);
  const dispatch = useStore((s) => s.dispatch);
  const pendingLocalCopy = useSessionStore((s) => s.pendingLocalCopy);

  useEffect(() => {
    if (restoredAt === null) return undefined;
    const timer = window.setTimeout(() => setRestoredAt(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [restoredAt, setRestoredAt]);

  if (pendingLocalCopy !== null) {
    const discard = (): void => {
      const storage = browserStorage();
      if (storage !== null) clearAutosave(storage);
      useSessionStore.getState().setPendingLocalCopy(null);
    };
    const restore = (): void => {
      dispatch(
        'load_document',
        { json: pendingLocalCopy.json },
        {
          onResult: ({ changed }) => {
            useSessionStore.getState().setPendingLocalCopy(null);
            if (!changed) return;
            useSessionStore.getState().setRestoredAt(pendingLocalCopy.savedAt);
            const storage = browserStorage();
            // Online the server now holds it; offline the next autosave rewrites it.
            if (storage !== null && useStore.getState().liveStatus === 'connected') clearAutosave(storage);
          },
        },
      );
    };
    return (
      <div className="restored-banner" role="alertdialog" aria-label="Unsaved local copy">
        <span>Unsaved work from {new Date(pendingLocalCopy.savedAt).toLocaleString()} was found on this device.</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={restore}>
          Restore local copy
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={discard}>
          Discard
        </button>
      </div>
    );
  }

  if (restoredAt === null) return null;

  const startFresh = (): void => {
    dispatch('clear_document', {});
    const storage = browserStorage();
    if (storage !== null) clearAutosave(storage);
    useSessionStore.getState().markSaved();
    setRestoredAt(null);
  };

  return (
    <div className="restored-banner" role="status">
      <span>Restored your unsaved work from {new Date(restoredAt).toLocaleString()}.</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={startFresh}>
        Start fresh
      </button>
      <IconButton icon="close" size={12} label="Dismiss restore notice" title="Dismiss" onClick={() => setRestoredAt(null)} />
    </div>
  );
}
