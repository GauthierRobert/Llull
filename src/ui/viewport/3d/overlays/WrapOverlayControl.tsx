// Toolbar control of the wrap review overlays: the master switch and, when on, the layers and the legend of the edge colours (UI-only state).

import React from 'react';
import { Icon } from '@ui/components/Icon';
import { WRAP_LAYERS, useWrapOverlayStore } from '@ui/store/wrapOverlayStore';
import { WRAP_COLORS } from './WrapOverlay';

const WRAP_OPTIONS_ID = 'wrap-overlay-options';
const LEGEND: ReadonlyArray<{ key: keyof typeof WRAP_COLORS; label: string }> = [
  { key: 'smooth', label: 'smooth join' },
  { key: 'convex', label: 'convex (mitred)' },
  { key: 'concave', label: 'concave (mitred)' },
  { key: 'unknown', label: 'unknown' },
];

export function WrapOverlayControl(): React.ReactElement {
  const enabled = useWrapOverlayStore((s) => s.enabled);
  const setEnabled = useWrapOverlayStore((s) => s.setEnabled);
  return (
    <div className="vp-group" role="group" aria-label="Wrap overlay">
      <button
        type="button"
        className={`vp-btn${enabled ? ' vp-btn--toggled' : ''}`}
        aria-pressed={enabled}
        aria-label="Wrap overlays"
        aria-expanded={enabled}
        aria-controls={WRAP_OPTIONS_ID}
        title={
          enabled
            ? 'Hide the curves on faces and the face joins of the selected solids'
            : 'Show the curves on faces (wrap, project, silhouette) and the face joins (smooth, convex, concave edges) of the selected solids (the first 4)'
        }
        onClick={() => setEnabled(!enabled)}
      >
        <Icon name="wrapSurface" size={14} />
        <span className="vp-btn__text">Wrap</span>
      </button>
    </div>
  );
}

/** The layers and the legend, under the toolbar while the master switch is on. */
export function WrapOverlayPopover(): React.ReactElement | null {
  const enabled = useWrapOverlayStore((s) => s.enabled);
  const layers = useWrapOverlayStore((s) => s.layers);
  const setLayer = useWrapOverlayStore((s) => s.setLayer);
  const status = useWrapOverlayStore((s) => s.status);
  if (!enabled) return null;
  const lines = Object.values(status).flat();
  return (
    <div id={WRAP_OPTIONS_ID} className="vp-popover vp-deform-options" role="group" aria-label="Wrap overlay layers">
      {WRAP_LAYERS.map(({ value, label, title }) => (
        <label key={value} className="vp-field-label" title={title}>
          <input type="checkbox" checked={layers[value]} onChange={(e) => setLayer(value, e.target.checked)} />
          {label}
        </label>
      ))}
      {lines.length > 0 && (
        <ul className="vp-wrap-status" role="status" aria-label="Wrap overlay status">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {layers.edges && (
        <ul className="vp-wrap-legend" aria-label="Face join colours">
          {LEGEND.map(({ key, label }) => (
            <li key={key}>
              <span className="vp-wrap-legend__swatch" style={{ background: WRAP_COLORS[key] }} aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
