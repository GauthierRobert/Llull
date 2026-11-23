// The recorded result of a case: coefficients, convergence, warnings and the drag history. Numbers are the recorded summary; the
// stale / unverified state and the warnings come from the read-only `cfd_report` (never recomputed here).

import React from 'react';
import { KpiStrip, PanelSection, StatusChip, type Kpi } from '@ui/panels/PanelParts';
import { SeriesChart } from '@ui/panels/SeriesChart';
import { caseBadge, num, type FlowReport, type FlowResult } from './flowData';

interface FlowResultSectionProps {
  result: FlowResult;
  report: FlowReport | null;
}

export function FlowResultSection({ result, report }: FlowResultSectionProps): React.ReactElement {
  const badge = caseBadge(result, report);
  const { forces } = result;
  const kpis: Kpi[] = [
    { key: 'cd', label: 'Cd', value: num(forces.cd) },
    { key: 'cl', label: 'Cl', value: num(forces.cl) },
    { key: 'cs', label: 'Cs', value: num(forces.cs) },
    { key: 'cda', label: 'CdA', value: num(forces.cdAM2), sub: 'm²' },
  ];
  const history = report?.history ?? [];
  return (
    <PanelSection title="Result" testId="flow-result">
      <p className="flow__state">
        <StatusChip tone={badge.tone} text={badge.text} testId="flow-state" />
        <span className="analysis__hint">
          {result.solver.toUpperCase()}, {result.provenance.device.name}
        </span>
      </p>
      <KpiStrip items={kpis} label="Force coefficients" />
      <p className="analysis__hint" data-testid="flow-convergence">
        {result.converged ? 'Converged' : 'Not converged'} after {report?.steps ?? result.provenance.steps} steps
        {report?.averagedSteps != null ? `, averaged over the last ${report.averagedSteps}` : ''}; grid{' '}
        {result.grid.cells.toLocaleString('en-US')} cells, cell {num(result.grid.finestCellM)} m.
      </p>
      {report?.stale === true && (
        <p className="flow__note flow__note--warn" role="status" data-testid="flow-stale">
          Stale: {report.staleReasons.join('; ') || 'the case or geometry changed since the solve'}. Solve again before trusting these
          numbers.
        </p>
      )}
      {(!result.verified || report?.trusted === false) && (
        <p className="flow__note flow__note--warn" data-testid="flow-unverified">
          Unverified: the result bundle is not in this machine's store. The numbers are the recorded claim; solve here to verify them.
        </p>
      )}
      {report !== null && report.warnings.length + report.solverWarnings.length > 0 && (
        <ul className="flow__warnings" aria-label="Warnings" data-testid="flow-warnings">
          {[...report.warnings, ...report.solverWarnings].map((warning) => (
            <li key={`${warning.code}:${warning.message}`}>
              <strong>{warning.code}</strong> {warning.message}
            </li>
          ))}
        </ul>
      )}
      {history.length >= 2 && (
        <SeriesChart
          title="Drag coefficient history"
          testId="flow-history"
          xs={history.map((row) => row.step)}
          series={[{ id: 'cd', label: 'Cd', values: history.map((row) => row.cd) }]}
          unit=""
          xUnit="steps"
          cursor={history[history.length - 1]?.step ?? 0}
        />
      )}
    </PanelSection>
  );
}
