// Persistent banners for host problems that must not pass unseen: autosave failing (A-11) and a view that cannot resync (TR-INT-16).

import React from 'react';
import { useHostStatusStore } from '@ui/store/hostStatusStore';

const AUTOSAVE_TEXT: Record<string, string> = {
  DSF_SAVE_DISK_FULL: 'The disk is full',
  DSF_SAVE_IO: 'The recovery copy could not be written',
  DSF_AUTOSAVE_FAILED: 'The document could not be serialized for the recovery copy',
};

export function HostStatusBanner(): React.ReactElement | null {
  const autosave = useHostStatusStore((s) => s.autosave);
  const outOfSync = useHostStatusStore((s) => s.outOfSync);
  if (autosave.ok && !outOfSync) return null;
  return (
    <div className="restored-banner host-status-banner" role="alert">
      {!autosave.ok && (
        <span>
          Autosave is failing ({autosave.code}): {AUTOSAVE_TEXT[autosave.code] ?? autosave.message}. Save your work to a file; llull keeps
          retrying.
        </span>
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
