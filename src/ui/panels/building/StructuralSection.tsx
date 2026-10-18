// Roof / wind loads → read-only structural checks (frames, bracing, foundations, crane runways; click selects) and
// design_portal_frames / design_purlins.

import React, { useEffect, useState } from 'react';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { runQuery } from '@ui/services/localQuery';
import type { BuildingModel } from '@core/model/building';
import { KpiStrip, ListRow, PanelSection, StatusChip, StatusLine, type Kpi } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import { useStructuralOverlayStore } from '@ui/store/structuralOverlayStore';
import { memberFocus } from './structuralFocus';
import { UTILISATION_COLORS, UTILISATION_LEGEND, toUtilisationMarks, utilisationBand, utilisationColor } from './utilisationColor';
import { isFailing, toWarnings, worstRows, type ReportRow } from './structuralReport';
import { LabeledInput } from '@ui/panels/LabeledInput';

interface Report {
  readonly summary: string;
  readonly rows: ReadonlyArray<ReportRow>;
  readonly warnings: ReadonlyArray<string>;
  readonly building: BuildingModel | undefined;
}

const CHECKS = [
  { command: 'check_portal_frames', label: 'Check frames', testId: 'frame-check' },
  { command: 'check_bracing', label: 'Bracing', testId: 'bracing-check' },
  { command: 'check_purlins', label: 'Purlins', testId: 'purlin-check' },
  { command: 'check_foundations', label: 'Foundations', testId: 'foundation-check' },
  { command: 'check_crane_runways', label: 'Runways', testId: 'runway-check' },
  { command: 'check_steel_members', label: 'Steel members', testId: 'steel-members-check' },
  { command: 'check_pipe_supports', label: 'Pipe supports', testId: 'pipe-support-check' },
] as const;

type CheckCommand = (typeof CHECKS)[number]['command'];

/** Multi-storey / rack check: its loads come from the model (slabs, equipment, pipes), not the form. */
const loadsFromModel: ReadonlySet<CheckCommand> = new Set(['check_steel_members', 'check_pipe_supports']);

function MemberRow({ row }: { row: ReportRow }): React.ReactElement {
  const document = useDocumentWithoutSelection();
  const focusItem = useFocusItem();
  const focus = memberFocus(document, row);
  const failing = isFailing(row);
  return (
    <ListRow
      buttonTestId="frame-check-row"
      swatch={utilisationColor(row.utilisation, !failing)}
      selected={useIsFocused(focus.key)}
      onSelect={() => focusItem(focus)}
    >
      <StatusChip tone={failing ? 'bad' : 'ok'} text={failing ? 'FAIL' : 'OK'} />
      <span className="panel__row-main">{row.label}</span>
      <span className="panel__row-meta">{row.detail !== '' ? row.detail : row.utilisation.toFixed(2)}</span>
    </ListRow>
  );
}

const BAND_TONE = { ok: 'ok', warn: 'warn', fail: 'bad' } as const;

/** Max utilisation and number of failing members of a check, as the panel's headline. */
function utilisationKpis(rows: readonly ReportRow[]): Kpi[] {
  const worst = rows.reduce((max, row) => Math.max(max, row.utilisation), 0);
  const failing = rows.filter(isFailing).length;
  return [
    { key: 'max-ur', label: 'Max utilisation', value: worst.toFixed(2), tone: BAND_TONE[utilisationBand(worst)] },
    { key: 'failing', label: 'Failing', value: `${failing} / ${rows.length}`, tone: failing > 0 ? 'bad' : 'ok' },
  ];
}

function OverlayToggle(): React.ReactElement {
  const shown = useStructuralOverlayStore((s) => s.shown);
  const setShown = useStructuralOverlayStore((s) => s.setShown);
  return (
    <div className="building-inline-form" data-testid="utilisation-legend">
      <label className="loads-check">
        <input type="checkbox" checked={shown} onChange={(event) => setShown(event.target.checked)} data-testid="utilisation-shown" />
        Colour members on the model
      </label>
      <span className="utilisation-legend">
        {UTILISATION_LEGEND.map(({ band, text }) => (
          <span key={band} className="panel__row-meta">
            <span className="panel__swatch" style={{ background: UTILISATION_COLORS[band], display: 'inline-block' }} aria-hidden="true" />{' '}
            {text}
          </span>
        ))}
      </span>
    </div>
  );
}

export function StructuralSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const dispatch = useStore((s) => s.dispatch);
  const [deadLoad, setDeadLoad] = useState('0.5');
  const [snowLoad, setSnowLoad] = useState('0.8');
  const [windPressure, setWindPressure] = useState('0');
  const [computed, setReport] = useState<Report | null>(null);
  const report = computed !== null && computed.building === building ? computed : null;
  const setMarks = useStructuralOverlayStore((s) => s.setMarks);
  useEffect(() => {
    setMarks(report === null ? [] : toUtilisationMarks(report.rows, building));
  }, [report, building, setMarks]);
  useEffect(() => () => setMarks([]), [setMarks]);
  const loads = { deadLoad: Number(deadLoad), snowLoad: Number(snowLoad), windPressure: Number(windPressure) };

  const runCheck = (command: CheckCommand): void => {
    const result = runQuery(command, loadsFromModel.has(command) ? {} : loads);
    setReport({ summary: result.summary, rows: worstRows(result.data), warnings: toWarnings(result.data), building });
  };

  return (
    <PanelSection
      title="Structural check"
      step={3}
      hint="Enter the design loads, then verify. Click a result to select that member in the model."
      collapsible
      testId="building-structure"
    >
      <div className="building-inline-form">
        <LabeledInput label="Roof dead load (kN/m²)" title="Roof dead load, kN/m²" type="number" value={deadLoad} onChange={setDeadLoad} />
        <LabeledInput label="Snow load (kN/m²)" title="Snow load, kN/m²" type="number" value={snowLoad} onChange={setSnowLoad} />
        <LabeledInput
          label="Wind pressure qp (kN/m²)"
          title="Peak velocity pressure qp, kN/m² (0 = no wind)"
          type="number"
          value={windPressure}
          onChange={setWindPressure}
        />
      </div>
      <p className="building-subhead">Verify (read-only, the model is not changed)</p>
      <div className="building-inline-form">
        {CHECKS.map((check) => (
          <button
            key={check.command}
            type="button"
            className={`btn btn--sm ${check.command === 'check_portal_frames' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => runCheck(check.command)}
            data-testid={check.testId}
          >
            {check.label}
          </button>
        ))}
      </div>
      <p className="building-subhead">Auto-size (changes member sizes · Ctrl Z to undo)</p>
      <div className="building-inline-form">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => dispatch('design_portal_frames', loads)}
          data-testid="frame-design"
        >
          Design frames
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            dispatch('design_purlins', { roofDeadLoad: loads.deadLoad, snowLoad: loads.snowLoad, windPressure: loads.windPressure })
          }
          data-testid="purlin-design"
        >
          Design purlins
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => dispatch('design_footings', loads)}
          data-testid="footing-design"
        >
          Design footings
        </button>
      </div>
      {report !== null && (
        <>
          <KpiStrip items={utilisationKpis(report.rows)} label="Structural summary" />
          {report.rows.some(isFailing) && (
            <p className="building-subhead" role="note" data-testid="frame-check-next-step">
              Some members fail: use Auto-size above to up-size them, then verify again.
            </p>
          )}
          <OverlayToggle />
          <details className="building-report">
            <summary>Full check report</summary>
            <StatusLine text={report.summary} testId="frame-check-summary" />
          </details>
          <ul className="panel__list" aria-label="Utilisations">
            {report.rows.map((row) => (
              <MemberRow key={row.key} row={row} />
            ))}
          </ul>
          {report.warnings.length > 0 && (
            <ul className="panel__list building-warnings" aria-label="Warnings">
              {report.warnings.map((warning) => (
                <li key={warning} className="panel__row panel__row-meta" role="note">
                  {warning}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PanelSection>
  );
}
