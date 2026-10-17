// Analysis › Check & solve, Results and Margins of one case. Every figure is a recorded summary or a read-only query result; meshing
// (Gmsh) and solving (CalculiX) run on the llull server and are recorded by command, so the document stays the only truth.

import React, { useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { ReviewBanner } from '@ui/panels/ReviewBanner';
import { meshAndSolve } from '@ui/services/analysisRun';
import {
  caseProgress,
  formatNumber,
  isThermalCase,
  parseCheck,
  parseMargins,
  parseProbeValues,
  parseTemperatureLimits,
  unitLabels,
  type StatusWord,
} from './analysisView';
import { useAnalysisQuery } from './useAnalysisQuery';

const GLYPH: Readonly<Record<StatusWord, string>> = { pass: '✔', warn: '▲', fail: '✖' };

function StatusMark({ status, label }: { status: StatusWord; label?: string }): React.ReactElement {
  return (
    <span className={`status-mark status-mark--${status}`}>
      <span className="status-mark__glyph" aria-hidden="true">
        {GLYPH[status]}
      </span>
      <span className="status-mark__word">{label ?? status}</span>
    </span>
  );
}

function StaleNote({ testId }: { testId: string }): React.ReactElement {
  return (
    <p className="review-panel__stale" role="status" data-testid={testId}>
      <span aria-hidden="true">◌</span> The case changed after this ran. Run it again to refresh.
    </p>
  );
}

export function CaseCheckSection({ analysis }: { analysis: AnalysisCase }): React.ReactElement {
  const thermal = isThermalCase(analysis.type);
  const check = useAnalysisQuery(thermal ? 'check_thermal' : 'check_analysis', analysis, parseCheck);
  const connected = useStore((s) => s.liveStatus === 'connected');
  const [solveStatus, setSolveStatus] = useState('');
  const [solving, setSolving] = useState(false);
  const progress = caseProgress(analysis);
  const solve = (): void => {
    setSolving(true);
    void meshAndSolve(analysis.id, setSolveStatus).then((result) => {
      setSolveStatus(result.summary);
      setSolving(false);
    });
  };
  const view = check.view;

  return (
    <PanelSection title="Check & solve" step={2} done={progress === 'solved'} testId="analysis-solve">
      <div className="mfg__actions">
        <button type="button" className="btn btn--sm" onClick={check.run} disabled={check.running} data-testid="analysis-check">
          {view === null ? 'Check readiness' : 'Re-check'}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={solve}
          disabled={!connected || solving}
          title={connected ? 'fea_mesh (Gmsh) then fea_solve (CalculiX) on the llull server' : 'Needs the llull server (Gmsh + CalculiX)'}
          data-testid="analysis-mesh-solve"
        >
          {solving ? 'Solving…' : progress === 'solved' ? 'Re-mesh & solve' : 'Mesh & solve'}
        </button>
      </div>
      {!connected && (
        <p className="analysis__note analysis__hint" data-testid="analysis-offline-hint">
          Meshing and solving run on the llull server. From a terminal: <code>llull fea_mesh analysisId={analysis.id}</code> then{' '}
          <code>llull fea_solve analysisId={analysis.id}</code>.
        </p>
      )}
      {solveStatus !== '' && (
        <p className="analysis__note" role="status" data-testid="analysis-solve-status">
          {solveStatus}
        </p>
      )}
      {view === null ? (
        check.summary !== '' && <p className="analysis__note">{check.summary}</p>
      ) : (
        <>
          {check.stale && <StaleNote testId="analysis-check-stale" />}
          <p className="mfg__figures" data-testid="analysis-check-overall">
            <StatusMark status={view.status} /> state <strong>{view.state}</strong> · {view.items.length} item(s)
          </p>
          <ul className="findings__list">
            {view.items.map((item, index) => (
              <li key={`${item.code}-${index}`} className="finding">
                <div className="finding__head">
                  <StatusMark status={item.severity === 'error' ? 'fail' : 'warn'} label={item.severity} />
                  <code className="finding__code">{item.code}</code>
                </div>
                <p className="finding__meta">{item.message}</p>
                <p className="finding__remediation">{item.remediation}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </PanelSection>
  );
}

function StaticResults({ analysis }: { analysis: AnalysisCase }): React.ReactElement | null {
  const probes = useAnalysisQuery('fea_report', analysis, parseProbeValues);
  const results = analysis.results;
  if (results === undefined) return null;
  const units = unitLabels(results.units);
  return (
    <>
      <table className="mfg__table analysis__table" data-testid="analysis-results-table">
        <thead>
          <tr>
            <th scope="col">Load case</th>
            <th scope="col">Max von Mises</th>
            <th scope="col">Max displacement</th>
          </tr>
        </thead>
        <tbody>
          {results.loadCases.map((loadCase) => (
            <tr key={loadCase.name}>
              <th scope="row">
                {loadCase.name}
                <span className="analysis__category">{loadCase.category}</span>
              </th>
              <td>
                {formatNumber(loadCase.maxVonMises.value)} {units.stress}
              </td>
              <td>
                {formatNumber(loadCase.maxDisplacement.value)} {units.length}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mfg__actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={probes.run}
          disabled={probes.running}
          data-testid="analysis-probes"
        >
          Read probes
        </button>
      </div>
      {probes.view === null
        ? probes.summary !== '' && <p className="analysis__note">{probes.summary}</p>
        : probes.view.map((probe) => (
            <p key={probe.probeId} className="mfg__figures" data-testid={`analysis-probe-${probe.probeId}`}>
              <strong>{probe.name}</strong>:{' '}
              {probe.values.map((value) => `${value.loadCase} ${formatNumber(value.value)} ${probe.unit}`).join(' · ')}
            </p>
          ))}
    </>
  );
}

function ThermalResults({ analysis }: { analysis: AnalysisCase }): React.ReactElement | null {
  const summary = analysis.results?.thermal;
  if (summary === undefined) return null;
  const scale = summary.temperatureScale === 'K' ? 'K' : '°C';
  const balance = summary.heatBalance;
  const balanced = balance.residualRel <= 1e-2;
  return (
    <>
      <dl className="analysis__figures" data-testid="analysis-thermal-results">
        <div>
          <dt>Hottest</dt>
          <dd>
            {formatNumber(summary.maxT.value)} {scale}
          </dd>
        </div>
        <div>
          <dt>Coldest</dt>
          <dd>
            {formatNumber(summary.minT.value)} {scale}
          </dd>
        </div>
        <div>
          <dt>Heat flow</dt>
          <dd>{formatNumber(balance.inW)} W</dd>
        </div>
      </dl>
      <p className="mfg__figures">
        <StatusMark status={balanced ? 'pass' : 'warn'} label={balanced ? 'balanced' : 'imbalance'} /> heat balance residual{' '}
        {formatNumber(balance.residualRel, 2)}
      </p>
      {summary.probes.map((probe) => {
        const last = probe.series[probe.series.length - 1];
        const name = analysis.probes[probe.probeId]?.name ?? probe.probeId;
        return last === undefined ? null : (
          <p key={probe.probeId} className="mfg__figures">
            <strong>{name}</strong>: {formatNumber(last[1])} {scale}
          </p>
        );
      })}
    </>
  );
}

export function CaseResultsSection({ analysis }: { analysis: AnalysisCase }): React.ReactElement {
  const solved = analysis.results !== undefined;
  const mesh = analysis.meshSummary;
  return (
    <PanelSection title="Results" step={3} done={solved} testId="analysis-results">
      {mesh !== undefined && (
        <p className="mfg__figures" data-testid="analysis-mesh-summary">
          Mesh: {mesh.nodes.toLocaleString('en-US')} nodes ·{' '}
          {Object.entries(mesh.elements)
            .map(([type, count]) => `${count.toLocaleString('en-US')} ${type}`)
            .join(' · ')}{' '}
          · {mesh.quality.inverted} inverted · {mesh.mesher} {mesh.mesherVersion}
        </p>
      )}
      {!solved ? (
        <p className="analysis__note">Not solved yet: mesh and solve the case first.</p>
      ) : isThermalCase(analysis.type) ? (
        <ThermalResults analysis={analysis} />
      ) : (
        <StaticResults analysis={analysis} />
      )}
      {solved && analysis.results?.solver !== undefined && (
        <p className="analysis__note">
          {analysis.results.solver} {analysis.results.solverVersion} · {analysis.results.units}
        </p>
      )}
    </PanelSection>
  );
}

function StructuralMargins({ analysis }: { analysis: AnalysisCase }): React.ReactElement {
  const margins = useAnalysisQuery('compute_margins', analysis, parseMargins);
  const view = margins.view;
  const units = unitLabels(analysis.unitSystem);
  return (
    <>
      <div className="mfg__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={margins.run}
          disabled={margins.running}
          data-testid="analysis-margins-run"
        >
          {view === null ? 'Compute margins' : 'Recompute'}
        </button>
      </div>
      {view === null ? (
        margins.summary !== '' && <p className="analysis__note">{margins.summary}</p>
      ) : (
        <>
          {margins.stale && <StaleNote testId="analysis-margins-stale" />}
          <ReviewBanner
            reason="Margins computed by llull, not approved: a qualified engineer must review them."
            unverified={view.rows.some((row) => row.unverified)}
          />
          <p className="mfg__figures" data-testid="analysis-margins-min">
            Minimum MS <strong>{view.minMs === undefined ? '—' : formatNumber(view.minMs)}</strong> · {view.factorsText}
          </p>
          <table className="mfg__table analysis__table" data-testid="analysis-margins-table">
            <thead>
              <tr>
                <th scope="col">Load case · check</th>
                <th scope="col">Applied / allowable</th>
                <th scope="col">MS</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.rowId}>
                  <th scope="row">
                    {row.loadCase}
                    <span className="analysis__category">
                      {row.category} · {row.check} ×{formatNumber(row.factor)}
                    </span>
                  </th>
                  <td title={row.allowableLabel}>
                    {formatNumber(row.applied)} / {formatNumber(row.allowable)} {units.stress}
                    <span className="analysis__category">{row.allowableLabel}</span>
                  </td>
                  <td>
                    <StatusMark status={row.status} label={formatNumber(row.ms)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function ThermalLimits({ analysis }: { analysis: AnalysisCase }): React.ReactElement {
  const limits = useAnalysisQuery('check_temperature_limits', analysis, parseTemperatureLimits);
  const rows = limits.view;
  return (
    <>
      <div className="mfg__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={limits.run}
          disabled={limits.running}
          data-testid="analysis-limits-run"
        >
          {rows === null ? 'Check temperature limits' : 'Re-check'}
        </button>
      </div>
      {rows === null ? (
        limits.summary !== '' && <p className="analysis__note">{limits.summary}</p>
      ) : (
        <>
          {limits.stale && <StaleNote testId="analysis-limits-stale" />}
          <ReviewBanner reason="Computed by llull, not approved: a qualified thermal engineer must review the conditions, sources and limits." />
          <table className="mfg__table analysis__table" data-testid="analysis-limits-table">
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col">Computed</th>
                <th scope="col">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.rowId}>
                  <th scope="row">
                    {row.name}
                    <span className="analysis__category">
                      {row.bound} {row.limit}
                    </span>
                  </th>
                  <td>{row.computed}</td>
                  <td>
                    <StatusMark status={row.status} label={row.marginK === undefined ? row.status : `${formatNumber(row.marginK)} K`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

export function CaseMarginsSection({ analysis }: { analysis: AnalysisCase }): React.ReactElement {
  const thermal = isThermalCase(analysis.type);
  return (
    <PanelSection title={thermal ? 'Temperature limits' : 'Margins of safety'} step={4} testId="analysis-margins">
      {analysis.results === undefined ? (
        <p className="analysis__note">Available once the case is solved.</p>
      ) : thermal ? (
        <ThermalLimits analysis={analysis} />
      ) : (
        <StructuralMargins analysis={analysis} />
      )}
    </PanelSection>
  );
}
