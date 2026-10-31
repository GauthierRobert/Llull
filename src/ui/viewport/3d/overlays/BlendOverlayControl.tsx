// Toolbar control of the blend review overlay: the master switch and, when on, the layers, the status line and the legend of the status colours (UI-only state).

import React from 'react';
import { Icon } from '@ui/components/Icon';
import { BLEND_LAYERS, useBlendOverlayStore } from '@ui/store/blendOverlayStore';
import { BLEND_STATUS_COLORS, CORNER_COLORS } from './BlendOverlay';

const BLEND_OPTIONS_ID = 'blend-overlay-options';
const LEGEND: ReadonlyArray<{ color: string; label: string }> = [
  { color: BLEND_STATUS_COLORS.pass, label: 'pass' },
  { color: BLEND_STATUS_COLORS.warn, label: 'warn' },
  { color: BLEND_STATUS_COLORS.fail, label: 'fail' },
  { color: BLEND_STATUS_COLORS.not_run, label: 'not run' },
  { color: CORNER_COLORS.star, label: 'corner: exact star' },
  { color: CORNER_COLORS.patch, label: 'corner: plate patch' },
];

export function BlendOverlayControl(): React.ReactElement {
  const enabled = useBlendOverlayStore((s) => s.enabled);
  const setEnabled = useBlendOverlayStore((s) => s.setEnabled);
  return (
    <div className="vp-group" role="group" aria-label="Blend overlay">
      <button
        type="button"
        className={`vp-btn${enabled ? ' vp-btn--toggled' : ''}`}
        aria-pressed={enabled}
        aria-label="Blend overlays"
        aria-expanded={enabled}
        aria-controls={BLEND_OPTIONS_ID}
        title={
          enabled
            ? 'Hide the blend review of the selected solids'
            : 'Review the blends of the selected solids (the first 4): contact lines, junctions, corner patches and chamfer legs, coloured by what check_blends measured'
        }
        onClick={() => setEnabled(!enabled)}
      >
        <Icon name="blendReview" size={14} />
        <span className="vp-btn__text">Blends</span>
      </button>
    </div>
  );
}

/** The layers, the status line and the legend, under the toolbar while the master switch is on. */
export function BlendOverlayPopover(): React.ReactElement | null {
  const enabled = useBlendOverlayStore((s) => s.enabled);
  const layers = useBlendOverlayStore((s) => s.layers);
  const setLayer = useBlendOverlayStore((s) => s.setLayer);
  const status = useBlendOverlayStore((s) => s.status);
  if (!enabled) return null;
  const lines = Object.values(status).flat();
  return (
    <div id={BLEND_OPTIONS_ID} className="vp-popover vp-deform-options" role="group" aria-label="Blend overlay layers">
      {BLEND_LAYERS.map(({ value, label, title }) => (
        <label key={value} className="vp-field-label" title={title}>
          <input type="checkbox" checked={layers[value]} onChange={(e) => setLayer(value, e.target.checked)} />
          {label}
        </label>
      ))}
      {lines.length > 0 && (
        <ul className="vp-wrap-status" role="status" aria-label="Blend overlay status">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <ul className="vp-wrap-legend" aria-label="Blend status colours">
        {LEGEND.map(({ color, label }) => (
          <li key={label}>
            <span className="vp-wrap-legend__swatch" style={{ background: color }} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
