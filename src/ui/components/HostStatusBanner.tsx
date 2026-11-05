// Persistent banners for host problems that must not pass unseen: autosave failing (A-11) and a view that cannot resync (TR-INT-16).

import React from 'react';
import { useHostStatusStore } from '@ui/store/hostStatusStore';
import { useRecoveryStore } from '@ui/store/recoveryStore';
import { useStore } from '@ui/store';

const AUTOSAVE_TEXT: Record<string, string> = {
  DSF_SAVE_DISK_FULL: 'The disk is full',
  DSF_SAVE_IO: 'The recovery copy could not be written',
  DSF_AUTOSAVE_FAILED: 'The document could not be serialized for the recovery copy',
};

export function HostStatusBanner(): React.ReactElement | null {
  const autosave = useHostStatusStore((s) => s.autosave);
  const outOfSync = useHostStatusStore((s) => s.outOfSync);
  const offlineEditsKept = useRecoveryStore((s) => s.offlineEditsKept);
  // The backend was there and is not now: the desktop restarts it (A-10); until then edits run locally and are kept.
  const reconnecting = useStore((s) => s.liveStatus === 'disconnected' && s.sseEverConnected);
  if (autosave.ok && !outOfSync && !offlineEditsKept && !reconnecting) return null;
  return (
    <div className="restored-banner host-status-banner" role="alert">
      {reconnecting && (
        <span>
          The backend is not responding; llull is restarting it. You can keep working: your edits are kept and offered back when it returns.
        </span>
      )}
      {!autosave.ok && (
        <span>
          Autosave is failing ({autosave.code}): {AUTOSAVE_TEXT[autosave.code] ?? autosave.message}. Save your work to a file; llull keeps
          retrying.
        </span>
      )}
      {offlineEditsKept && (
        <>
          <span>The edits you made while the backend was offline were kept as a recoverable copy next to the backend&apos;s document.</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => useRecoveryStore.getState().setOpen(true)}>
            Review
          </button>
        </>
      )}
      {outOfSync && (
        <>
          <span>The view is out of sync with the backend (OUT_OF_SYNC). Reload to show the backend&apos;s document.</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => window.location.reload()}>
            Reload
          </button>
        </>
      )}
    </div>
  );
}
