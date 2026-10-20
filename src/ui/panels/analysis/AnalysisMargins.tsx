// Margins of safety of a solved static / thermo_static case: the compute_margins table (read-only, server-side when online).
// Computed by llull, not approved: every row waits for a qualified engineer.

import React, { useMemo } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { classNames } from '@ui/classNames';
import { PanelSection, StatusChip, StatusLine } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { dispositionText, minMsTone, parseMargins, statusToneOf, type MarginRowView, type MarginsView } from './marginsData';
import { formatSignificant } from './quantityFormat';
import { useHostQuery } from './useHostQuery';

const COLUMNS = ['Part', 'Region', 'Load case', 'Check', 'Applied', 'Allowable', 'MS', 'Status', 'Disposition'] as const;

const regionText = (row: MarginRowView): string => (row.fibre === null ? row.region : `${row.region} · ${row.fibre} fibre`);
const stressText = (value: number | null, unit: string): string => (value === null ? '—' : `${formatSignificant(value)} ${unit}`);

function MarginRow({ row }: { row: MarginRowView }): React.ReactElement {
  const note = dispositionText(row.disposition);
  return (
    <tr
      className={classNames('analysis__margin-row', row.singular && 'analysis__margin-row--singular')}
      data-testid={`analysis-margin-${row.rowId}`}
      data-singular={row.singular ? 'true' : undefined}
    >
      <td>{row.part}</td>
      <td>{regionText(row)}</td>
      <td>{row.loadCase}</td>
      <td>
        {row.check} · {row.criterion}
      </td>
      <td>{stressText(row.applied, row.unit)}</td>
      <td>{stressText(row.allowable, row.unit)}</td>
      <td className="analysis__margin-ms">{row.ms === null ? '—' : formatSignificant(row.ms, 3)}</td>
      <td>
        <span className={`analysis__margin-status analysis__margin-status--${statusToneOf(row.status)}`}>{row.statusLabel}</span>
      </td>
      <td>
        {note === '' ? '—' : <span className={classNames(row.disposition === 'pending_human' && 'analysis__margin-pending')}>{note}</span>}
      </td>
    </tr>
  );
}

function MarginTable({ view }: { view: MarginsView }): React.ReactElement {
  const regular = view.rows.filter((row) => !row.singular);
  const singular = view.rows.filter((row) => row.singular);
  return (
    <div className="analysis__margins-scroll">
      <table className="analysis__margins" data-testid="analysis-margins-table">
        <thead>
          <tr>
            {COLUMNS.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {regular.map((row) => (
            <MarginRow key={row.rowId} row={row} />
          ))}
        </tbody>
        {singular.length > 0 && (
          <tbody className="analysis__margins-singular" data-testid="analysis-margins-singular">
            <tr>
              <th colSpan={COLUMNS.length} scope="colgroup">
                Singular zones: peak stress next to a point / edge load or a point / edge support of a solid. Judge these by hand; do not
                trust the margin.
              </th>
            </tr>
            {singular.map((row) => (
              <MarginRow key={row.rowId} row={row} />
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

export function AnalysisMargins({ analysisCase }: { analysisCase: AnalysisCase }): React.ReactElement {
  const document = useStore((s) => s.document);
  const { id, marginalBand } = analysisCase;
  const params = useMemo(() => ({ analysisId: id, ...(marginalBand === undefined ? {} : { marginalBand }) }), [id, marginalBand]);
  const answer = useHostQuery('compute_margins', params, document);
  const view = answer.status === 'done' && !answer.isError ? parseMargins(answer.data) : null;

  return (
    <PanelSection title="Margins of safety" hint="Computed from the verified results artifact against the material allowables.">
      {answer.status === 'loading' && <StatusLine text="Computing margins…" />}
      {answer.status === 'done' && view === null && <StatusLine text={answer.summary} testId="analysis-margins-refused" />}
      {view !== null && (
        <>
          <div className="analysis__margins-head">
            <StatusChip
              tone={minMsTone(view)}
              text={view.minMs === null ? 'No finite margin' : `Min MS ${formatSignificant(view.minMs, 3)}`}
              testId="analysis-margins-min"
            />
            {view.reviewRequired && (
              <p className="analysis__review" data-testid="analysis-margins-review">
                Computed by llull, not approved — needs a qualified engineer.
              </p>
            )}
          </div>
          {view.warnings.length > 0 && (
            <ul className="analysis__margins-warnings" aria-label="Margin warnings" data-testid="analysis-margins-warnings">
              {view.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {view.singularScreening !== '' && (
            <p className="analysis__hint" data-testid="analysis-margins-screening">
              {view.singularScreening}
            </p>
          )}
          <MarginTable view={view} />
        </>
      )}
    </PanelSection>
  );
}
