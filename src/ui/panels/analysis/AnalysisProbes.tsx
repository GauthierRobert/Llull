// Probe time series of a solved case (probe_history): the chart, and a start / end / peak table per probe (temperatures, heat flux, stresses).

import React, { useState } from 'react';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import type { SetupItem } from './analysisItems';
import { SetupRow } from './SetupRow';
import { svgDataUrl, parseProbeHistory } from './analysisData';
import { PlotDialog } from './PlotDialog';
import { formatQuantities } from './quantityFormat';
import { useHostQuery } from './useHostQuery';

interface AnalysisProbesProps {
  analysisId: string;
  refreshKey: unknown;
  /** Probe set-up items by probe id: rows of probes that exist on the model highlight them. */
  items: Readonly<Record<string, SetupItem>>;
}

export function AnalysisProbes({ analysisId, refreshKey, items }: AnalysisProbesProps): React.ReactElement {
  const query = useHostQuery('probe_history', { analysisId }, refreshKey);
  const [full, setFull] = useState(false);
  const view = query.status === 'done' && !query.isError ? parseProbeHistory(query.data) : null;
  return (
    <PanelSection title="Probes" hint="Value of each result probe over the stored increments (probe_history).">
      {query.status === 'loading' && <StatusLine text="Reading probes…" />}
      {query.status === 'done' && view === null && <StatusLine text={query.summary} testId="analysis-probes-summary" />}
      {view !== null && view.series.length === 0 && (
        <StatusLine text="No probes defined (add_result_probe)." testId="analysis-probes-empty" />
      )}
      {view?.svg != null && (
        <figure className="analysis__figure">
          <img className="analysis__plot" data-testid="analysis-probe-plot" alt="Probe history chart" src={svgDataUrl(view.svg)} />
          <button type="button" className="btn btn--ghost" data-testid="analysis-probe-open-full" onClick={() => setFull(true)}>
            Open full size
          </button>
        </figure>
      )}
      {full && view?.svg != null && (
        <PlotDialog
          src={svgDataUrl(view.svg)}
          alt="Probe history chart, full size"
          label="Probe history, full size"
          onClose={() => setFull(false)}
        />
      )}
      {view !== null && view.series.length > 0 && (
        <ul className="panel__list" aria-label="Probes" data-testid="analysis-probes">
          {view.series.map((probe) => {
            const first = probe.points[0];
            const last = probe.points[probe.points.length - 1];
            const values = probe.points.map((p) => p.value);
            const shown = formatQuantities(
              first === undefined || last === undefined ? [] : [first.value, last.value, Math.min(...values), Math.max(...values)],
              probe.unit,
            );
            const detail =
              first === undefined || last === undefined
                ? `${probe.quantity} · no values`
                : `${probe.quantity} · ${shown.texts[0]} → ${shown.texts[1]} (min ${shown.texts[2]}, max ${shown.texts[3]}) ${shown.unit}`;
            const item = items[probe.probeId];
            return item === undefined ? (
              <li key={probe.probeId} className="analysis__item">
                <span className="analysis__item-name">{probe.name}</span>
                <span className="analysis__item-detail">{detail}</span>
              </li>
            ) : (
              <SetupRow
                key={probe.probeId}
                item={item}
                meta={last === undefined ? '' : `${shown.texts[1]} ${shown.unit}`}
                detail={detail}
              />
            );
          })}
        </ul>
      )}
    </PanelSection>
  );
}
