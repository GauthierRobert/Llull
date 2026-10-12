/**
 * @layer ui/components
 *
 * UpdateBanner — "a new version of llull is ready" with a Reload button. Binds the state of
 * `@ui/services/appUpdates` (the only service-worker owner); presentation only.
 */

import React from 'react';
import { applyAppUpdate, useAppUpdateAvailable } from '@ui/services/appUpdates';

export function UpdateBanner(): React.ReactElement | null {
  const updateAvailable = useAppUpdateAvailable();
  if (!updateAvailable) return null;
  return (
    <div className="restored-banner update-banner" role="status">
      <span>A new version of llull is ready.</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={applyAppUpdate}>
        Reload
      </button>
    </div>
  );
}
