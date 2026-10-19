// "Show on model": toggle for the set-up glyphs and the painted result, the colour key of the glyphs, and why nothing is painted.

import React from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { COLORS } from './analysisItems';
import { useAnalysisViewStore } from './analysisViewStore';

const KEY: readonly { color: string; text: string }[] = [
  { color: COLORS.constraint, text: 'Supports' },
  { color: COLORS.load, text: 'Loads' },
  { color: COLORS.temperature, text: 'Temperature' },
  { color: COLORS.flux, text: 'Heat flux' },
  { color: COLORS.film, text: 'Convection' },
  { color: COLORS.radiation, text: 'Radiation' },
  { color: COLORS.generation, text: 'Heat generation' },
  { color: COLORS.probe, text: 'Probes' },
];

export function AnalysisOnModel({ thermal, solved }: { thermal: boolean; solved: boolean }): React.ReactElement {
  const show = useAnalysisViewStore((s) => s.showOnModel);
  const setShow = useAnalysisViewStore((s) => s.setShowOnModel);
  const feed = useAnalysisViewStore((s) => s.surface);
  const paint =
    feed.status === 'ready'
      ? 'The result is painted on the model (colour legend bottom-left of the 3D view).'
      : feed.status === 'loading'
        ? 'Painting the result on the model…'
        : feed.status === 'refused'
          ? `Result not painted: ${feed.reason}`
          : solved
            ? 'Open the 3D view to see the result painted on the model.'
            : 'Not solved yet: only the set-up is drawn on the model.';
  return (
    <PanelSection title="On the model" hint="Supports, loads and results are drawn on the 3D model; click a row to highlight it.">
      <label className="field analysis__check">
        <input type="checkbox" data-testid="analysis-show-on-model" checked={show} onChange={(e) => setShow(e.target.checked)} />
        <span>Show on model</span>
      </label>
      {show && (
        <>
          <ul className="analysis__key" aria-label="Colour key">
            {KEY.filter(
              (entry) => thermal || !['Temperature', 'Heat flux', 'Convection', 'Radiation', 'Heat generation'].includes(entry.text),
            ).map((entry) => (
              <li key={entry.text} className="analysis__key-item">
                <span className="panel__swatch" style={{ background: entry.color }} aria-hidden="true" />
                {entry.text}
              </li>
            ))}
          </ul>
          <p className="analysis__line" data-testid="analysis-paint-status">
            {paint}
          </p>
        </>
      )}
    </PanelSection>
  );
}
