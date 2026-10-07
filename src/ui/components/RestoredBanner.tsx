/**
 * @layer ui/components
 *
 * RestoredBanner — tells the user their unsaved work was restored from autosave and offers
 * "Start fresh" (dispatches `clear_document`, drops the autosave). Presentation only.
 */

import React, { useEffect } from 'react';
import { useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { clearAutosave } from '@ui/store/autosave';
import { Icon } from '@ui/components/Icon';

/** The notice hides itself after this long; the restored work stays. */
const AUTO_DISMISS_MS = 20_000;

export function RestoredBanner(): React.ReactElement | null {
  const restoredAt = useSessionStore((s) => s.restoredAt);
  const setRestoredAt = useSessionStore((s) => s.setRestoredAt);
  const dispatch = useStore((s) => s.dispatch);

  useEffect(() => {
    if (restoredAt === null) return undefined;
    const timer = window.setTimeout(() => setRestoredAt(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [restoredAt, setRestoredAt]);

  if (restoredAt === null) return null;

  const startFresh = (): void => {
    dispatch('clear_document', {});
    try {
      clearAutosave(window.localStorage);
    } catch {
      // storage unavailable: nothing to clear
    }
    useSessionStore.getState().markSaved();
    setRestoredAt(null);
  };

  return (
    <div className="restored-banner" role="status">
      <span>Restored your unsaved work from {new Date(restoredAt).toLocaleString()}.</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={startFresh}>
        Start fresh
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setRestoredAt(null)}
        aria-label="Dismiss restore notice"
        title="Dismiss"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
