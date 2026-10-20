// Case actions: set the marginal band, delete the case (confirmed), and the human disposition gate (not available here).
// Each button only gathers params and dispatches the registered command.

import React, { useId, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { ConfirmDialog } from '@ui/components/ConfirmDialog';
import { PanelSection } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';

/** The band typed in the field: undefined = empty (clears the band), null = not a finite number >= 0. */
function parseBand(text: string): number | undefined | null {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function AnalysisActions({ analysisCase }: { analysisCase: AnalysisCase }): React.ReactElement {
  const ids = useId();
  const dispatch = useStore((s) => s.dispatch);
  const [band, setBand] = useState(analysisCase.marginalBand === undefined ? '' : String(analysisCase.marginalBand));
  const [confirming, setConfirming] = useState(false);
  const parsed = parseBand(band);

  return (
    <PanelSection title="Actions" hint="Owner decisions on this case.">
      <div className="analysis__controls">
        <label className="field" htmlFor={`${ids}-band`}>
          <span className="field__label">Marginal band (MS units)</span>
          <input
            id={`${ids}-band`}
            type="number"
            min={0}
            step="any"
            placeholder="none"
            data-testid="analysis-margin-band"
            value={band}
            onChange={(e) => setBand(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn"
          data-testid="analysis-set-margin-band"
          disabled={parsed === null}
          onClick={() =>
            dispatch('set_margin_band', {
              analysisId: analysisCase.id,
              ...(parsed === undefined || parsed === null ? {} : { marginalBand: parsed }),
            })
          }
        >
          Set margin band
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="analysis-disposition"
          disabled
          title="A margin disposition is a human decision that needs a signature; this app has no signing port yet."
        >
          Disposition…
        </button>
        <p className="analysis__hint">Dispositioning a FAIL / MARGINAL row is a signed human decision: not available in the app yet.</p>
        <button type="button" className="btn btn--danger" data-testid="analysis-delete" onClick={() => setConfirming(true)}>
          Delete analysis
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Delete analysis?"
          message={`"${analysisCase.name}" with its set-up, mesh and results will be removed. The geometry is not affected.`}
          confirmLabel="Delete"
          onConfirm={() => {
            setConfirming(false);
            dispatch('delete_analysis', { analysisId: analysisCase.id });
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </PanelSection>
  );
}
