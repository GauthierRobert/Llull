// Probe time series of a solved case (probe_history): the chart, and a start / end / peak table per probe (temperatures, heat flux, stresses).

import React from 'react';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { svgDataUrl, parseProbeHistory } from './analysisData';
import { useHostQuery } from './useHostQuery';

const round = (n: number): string => String(Math.round(n * 1e4) / 1e4);

export function AnalysisProbes({ analysisId, refreshKey }: { analysisId: string; refreshKey: unknown }): React.ReactElement {
  const query = useHostQuery('probe_history', { analysisId }, refreshKey);
  const view = query.status === 'done' && !query.isError ? parseProbeHistory(query.data) : null;
  return (
    <PanelSection title="Probes" hint="Value of each result probe over the stored increments (probe_history).">
      {query.status === 'loading' && <StatusLine text="Reading probes…" />}
      {query.status === 'done' && view === null && <StatusLine text={query.summary} testId="analysis-probes-summary" />}
      {view !== null && view.series.length === 0 && (
        <StatusLine text="No probes defined (add_result_probe)." testId="analysis-probes-empty" />
      )}
      {view?.svg != null && (
        <img className="analysis__plot" data-testid="analysis-probe-plot" alt="Probe history chart" src={svgDataUrl(view.svg)} />
      )}
      {view !== null && view.series.length > 0 && (
        <ul className="analysis__items" aria-label="Probes" data-testid="analysis-probes">
          {view.series.map((probe) => {
            const first = probe.points[0];
            const last = probe.points[probe.points.length - 1];
            const values = probe.points.map((p) => p.value);
            return (
              <li key={probe.probeId} className="analysis__item">
                <span className="analysis__item-name">{probe.name}</span>
                <span className="analysis__item-detail">
                  {probe.quantity}
                  {first === undefined || last === undefined
                    ? ' · no values'
                    : ` · ${round(first.value)} → ${round(last.value)} (min ${round(Math.min(...values))}, max ${round(Math.max(...values))}) ${probe.unit}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </PanelSection>
  );
}
