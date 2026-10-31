// Toolbar switch of the implicit GPU preview and the note that names the bodies that stay on the mesh preview (UI-only state).

import React from 'react';
import { Icon } from '@ui/components/Icon';
import { useImplicitPreviewStore } from '@ui/store/implicitPreviewStore';

export function ImplicitPreviewControl(): React.ReactElement {
  const enabled = useImplicitPreviewStore((s) => s.enabled);
  const setEnabled = useImplicitPreviewStore((s) => s.setEnabled);
  return (
    <div className="vp-group" role="group" aria-label="Implicit preview">
      <button
        type="button"
        className={`vp-btn${enabled ? ' vp-btn--toggled' : ''}`}
        aria-pressed={enabled}
        aria-label="GPU preview of implicit bodies"
        title={
          enabled
            ? 'Hide the ray-marched GPU preview of the selected implicit bodies'
            : 'Show a ray-marched GPU preview of the selected implicit bodies (their field compiled to a shader; fields without a GPU path keep the mesh)'
        }
        onClick={() => setEnabled(!enabled)}
      >
        <Icon name="transformMove" size={14} />
        <span className="vp-btn__text">GPU</span>
      </button>
    </div>
  );
}

/** Which selected bodies have no GPU path and why; empty while the switch is off or every body is drawn on the GPU. */
export function ImplicitPreviewNote(): React.ReactElement | null {
  const enabled = useImplicitPreviewStore((s) => s.enabled);
  const fallbacks = useImplicitPreviewStore((s) => s.fallbacks);
  if (!enabled) return null;
  const blocked = Object.entries(fallbacks).filter(([, names]) => names.length > 0);
  if (blocked.length === 0) return null;
  return (
    <div className="vp-popover vp-gpu-note" role="status">
      {blocked.map(([id, names]) => `${id}: mesh preview (no GPU path for ${names.join(', ')})`).join('; ')}
    </div>
  );
}
