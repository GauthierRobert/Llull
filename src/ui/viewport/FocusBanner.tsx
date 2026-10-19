// Chip over the viewport naming the highlighted panel item, so the engineer always knows what the beacons / selection show; ✕ clears it.

import React from 'react';
import { useStore } from '@ui/store';
import { type PanelFocus, useFocusStore } from '@ui/store/focusStore';
import { Icon } from '@ui/components/Icon';

interface FocusBannerProps {
  /** 3D: frames the highlighted item ("Zoom to"); absent where the view has no free camera. */
  onZoom?: (focus: PanelFocus) => void;
}

export function FocusBanner({ onZoom }: FocusBannerProps = {}): React.ReactElement | null {
  const focus = useFocusStore((s) => s.focus);
  const setFocus = useFocusStore((s) => s.setFocus);
  const clearSelection = useStore((s) => s.clearSelection);
  if (focus === null) return null;
  return (
    <div className="focus-banner" role="status" data-testid="focus-banner" style={{ borderColor: focus.color }}>
      <span className="focus-banner__swatch" style={{ background: focus.color }} aria-hidden="true" />
      <span className="focus-banner__label">{focus.label}</span>
      {onZoom !== undefined && (
        <button type="button" className="focus-banner__zoom" title="Frame it in the view" onClick={() => onZoom(focus)}>
          Zoom to
        </button>
      )}
      <button
        type="button"
        className="focus-banner__clear"
        aria-label="Clear highlight"
        title="Clear highlight"
        onClick={() => {
          setFocus(null);
          if (focus.entityIds.length > 0) clearSelection();
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
