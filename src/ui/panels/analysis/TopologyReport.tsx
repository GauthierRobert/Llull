// Verified result of a study (topology_report): headline numbers, the compliance / volume history plot, the concept / unverified
// badges and the threshold slider (set_topology_settings { threshold }).

import React, { useId, useState } from 'react';
import type { TopologyStudy } from '@core/model/topology';
import { useStore } from '@ui/store';
import { KpiStrip, PanelSection, StatusChip, StatusLine, type Kpi } from '@ui/panels/PanelParts';
import { formatSignificant } from './quantityFormat';
import { historyPlot, type TopologyReportView, type TopologyResultView } from './topologyData';

const PLOT = { width: 240, height: 80 } as const;
const STATE_TEXT: Readonly<Record<string, string>> = {
  unsolved: 'Not solved yet',
  solved: 'Solved',
  stale: 'Stale: set-up changed since the solve',
  missing: 'Result artifact missing',
  untrusted: 'Recorded result does not match its artifact',
};

function HistoryPlot({ result }: { result: TopologyResultView }): React.ReactElement | null {
  const paths = historyPlot(result.history, PLOT);
  if (paths === null) return null;
  return (
    <figure className="analysis__figure" data-testid="topology-history">
      <svg
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        className="topology__plot"
        role="img"
        aria-label="Compliance and volume per iteration"
      >
        <polyline points={paths.compliance} className="topology__line topology__line--compliance" fill="none" />
        <polyline points={paths.volume} className="topology__line topology__line--volume" fill="none" />
      </svg>
      <figcaption className="analysis__caption">
        <span className="topology__key topology__key--compliance">compliance</span>{' '}
        <span className="topology__key topology__key--volume">volume</span> per iteration (each scaled to its own range),{' '}
        {result.history.length} rows
      </figcaption>
    </figure>
  );
}

/** Dispatches only when the drag or key press ends: one command per decision, not per pixel. */
function ThresholdSlider({ study }: { study: TopologyStudy }): React.ReactElement {
  const id = useId();
  const dispatch = useStore((s) => s.dispatch);
  const stored = study.settings.threshold.value;
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? stored;
  const commit = (): void => {
    if (draft !== null && draft !== stored) dispatch('set_topology_settings', { studyId: study.id, threshold: draft });
    setDraft(null);
  };
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">Solid threshold {formatSignificant(shown)}</span>
      <input
        id={id}
        type="range"
        min={0.05}
        max={0.95}
        step={0.05}
        data-testid="topology-threshold"
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  );
}

function kpisOf(result: TopologyResultView, study: TopologyStudy): Kpi[] {
  const grey = result.grey > study.settings.greyLimit.value ? 'warn' : 'ok';
  return [
    { key: 'compliance', label: 'Compliance', value: formatSignificant(result.compliance), sub: result.complianceUnit },
    {
      key: 'iterations',
      label: 'Iterations',
      value: String(result.iterations),
      sub: result.status,
      tone: result.status === 'converged' ? 'ok' : 'warn',
    },
    { key: 'volume', label: 'Volume fraction', value: formatSignificant(result.volumeFraction) },
    { key: 'grey', label: 'Grey', value: formatSignificant(result.grey), tone: grey },
  ];
}

interface TopologyReportProps {
  study: TopologyStudy;
  report: TopologyReportView | null;
  summary: string;
}

export function TopologyReport({ study, report, summary }: TopologyReportProps): React.ReactElement {
  return (
    <PanelSection title="Result" hint="A concept shape: rebuild it with ordinary modelling commands and have an engineer review it.">
      {report === null ? (
        <StatusLine text={summary} testId="topology-report-summary" />
      ) : (
        <>
          <div className="topology__badges">
            <StatusChip
              tone={report.state === 'solved' ? 'ok' : 'warn'}
              text={STATE_TEXT[report.state] ?? report.state}
              testId="topology-state"
            />
            {report.concept && <StatusChip tone="info" text="concept" testId="topology-badge-concept" />}
            {report.unverified && <StatusChip tone="warn" text="unverified" testId="topology-badge-unverified" />}
          </div>
          {report.unverified && report.unverifiedReasons.length > 0 && (
            <p className="analysis__hint" data-testid="topology-unverified-reasons">
              Unverified inputs: {report.unverifiedReasons.join('; ')}
            </p>
          )}
          {report.problem !== null && <StatusLine text={report.problem} testId="topology-problem" />}
          {report.result !== null && (
            <>
              <KpiStrip label="Topology result" items={kpisOf(report.result, study)} />
              <HistoryPlot result={report.result} />
              <ThresholdSlider key={study.settings.threshold.value} study={study} />
            </>
          )}
        </>
      )}
    </PanelSection>
  );
}
