/**
 * @layer ui/panels/building
 *
 * StructuralSection — roof / wind loads → the read-only structural checks (frames, bracing,
 * foundations, crane runways; utilisation list, click selects the element) and
 * design_portal_frames / design_purlins (dispatched; up-size sections, bolt groups, purlins and rails).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';
import type { BuildingModel } from '@core/model/building';
import { ListRow, PanelSection, StatusLine } from '@ui/panels/PanelParts';
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

export function StructuralSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const select = useStore((s) => s.select);
  const dispatch = useStore((s) => s.dispatch);
  const [deadLoad, setDeadLoad] = useState('0.5');
  const [snowLoad, setSnowLoad] = useState('0.8');
  const [windPressure, setWindPressure] = useState('0');
  const [computed, setReport] = useState<Report | null>(null);
  const report = computed !== null && computed.building === building ? computed : null;
  const loads = {
    deadLoad: Number(deadLoad),
    snowLoad: Number(snowLoad),
    windPressure: Number(windPressure),
  };

  const runCheck = (command: CheckCommand): void => {
    const result = runQuery(command, loadsFromModel.has(command) ? {} : loads);
    setReport({
      summary: result.summary,
      rows: worstRows(result.data),
      warnings: toWarnings(result.data),
      building,
    });
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
            dispatch('design_purlins', {
              roofDeadLoad: loads.deadLoad,
              snowLoad: loads.snowLoad,
              windPressure: loads.windPressure,
            })
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
          <StatusLine text={report.summary} testId="frame-check-summary" />
          {report.rows.some(isFailing) && (
            <p className="building-subhead" role="note" data-testid="frame-check-next-step">
              Some members fail: use Auto-size above to up-size them, then verify again.
            </p>
          )}
          <ul className="panel__list" aria-label="Utilisations">
            {report.rows.map((row) => (
              <ListRow
                key={row.key}
                buttonTestId="frame-check-row"
                onSelect={() => select(building?.elements[row.elementId]?.entityIds ?? [])}
              >
                {isFailing(row) ? <span className="chip chip--danger">FAIL</span> : <span className="chip chip--success">OK</span>}
                <span className="panel__row-main">{row.label}</span>
                <span className="panel__row-meta">{row.detail !== '' ? row.detail : row.utilisation.toFixed(2)}</span>
              </ListRow>
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
