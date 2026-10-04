/**
 * @layer ui/panels/building
 *
 * StructuralSection — roof / wind loads → the read-only structural checks (frames, bracing,
 * foundations, crane runways; utilisation list, click selects the element) and
 * design_portal_frames / design_purlins (dispatched; up-size sections, bolt groups, purlins and rails).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import type { BuildingModel } from '@core/model/building';
import { PanelSection } from '@ui/panels/PanelParts';

/** The fields every structural check row shares (frames, bracing, foundations, runways). */
interface ReportRow {
  readonly key: string;
  readonly elementId: string;
  readonly label: string;
  readonly utilisation: number;
  /** False when the command reports the row as failing / not analysed whatever its utilisation. */
  readonly ok: boolean;
}

interface Report {
  readonly summary: string;
  readonly rows: ReadonlyArray<ReportRow>;
  readonly building: BuildingModel | undefined;
}

const CHECKS = [
  { command: 'check_portal_frames', label: 'Check frames', testId: 'frame-check' },
  { command: 'check_bracing', label: 'Bracing', testId: 'bracing-check' },
  { command: 'check_purlins', label: 'Purlins', testId: 'purlin-check' },
  { command: 'check_foundations', label: 'Foundations', testId: 'foundation-check' },
  { command: 'check_crane_runways', label: 'Runways', testId: 'runway-check' },
  { command: 'check_steel_members', label: 'Steel members', testId: 'steel-members-check' },
] as const;

type CheckCommand = (typeof CHECKS)[number]['command'];

/** Multi-storey / rack check: its loads come from the model (slabs, equipment, pipes), not the form. */
const loadsFromModel: ReadonlySet<CheckCommand> = new Set(['check_steel_members']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function toReportRows(data: unknown): ReportRow[] {
  const rows: unknown = isRecord(data) ? (data.rows ?? data.members) : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown, index): ReportRow[] => {
    if (!isRecord(row) || typeof row.utilisation !== 'number') return [];
    const text = (key: string): string => {
      const value = row[key];
      return typeof value === 'string' ? value : '';
    };
    const label = [text('mark') || text('column'), text('kind') || text('check'), text('frame')]
      .filter((part) => part !== '')
      .join(' · ');
    return [
      {
        key: `${index}:${text('elementId')}`,
        elementId: text('elementId') || text('id'),
        label,
        utilisation: row.utilisation,
        ok: row.ok !== false,
      },
    ];
  });
}

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
    const result = execute(
      useStore.getState().document,
      command,
      loadsFromModel.has(command) ? {} : loads,
    );
    setReport({
      summary: result.summary,
      rows: toReportRows(result.data)
        .sort((a, b) => b.utilisation - a.utilisation)
        .slice(0, 12),
      building,
    });
  };

  return (
    <PanelSection title="Structural check" collapsible testId="building-structure">
      <div className="building-inline-form">
        <input
          type="number"
          value={deadLoad}
          onChange={(event) => setDeadLoad(event.target.value)}
          aria-label="Roof dead load (kN/m²)"
          title="Roof dead load, kN/m²"
        />
        <input
          type="number"
          value={snowLoad}
          onChange={(event) => setSnowLoad(event.target.value)}
          aria-label="Snow load (kN/m²)"
          title="Snow load, kN/m²"
        />
        <input
          type="number"
          value={windPressure}
          onChange={(event) => setWindPressure(event.target.value)}
          aria-label="Wind pressure qp (kN/m²)"
          title="Peak velocity pressure qp, kN/m² (0 = no wind)"
        />
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
          <p className="building-summary" role="status" data-testid="frame-check-summary">
            {report.summary}
          </p>
          <ul className="panel__list" aria-label="Utilisations">
            {report.rows.map((row) => (
              <li key={row.key} className="panel__row">
                <button
                  type="button"
                  className="building-row-btn"
                  onClick={() => select(building?.elements[row.elementId]?.entityIds ?? [])}
                  data-testid="frame-check-row"
                >
                  <span className="chip">{row.utilisation > 1 || !row.ok ? 'FAIL' : 'OK'}</span>
                  <span className="panel__row-main">{row.label}</span>
                  <span className="panel__row-meta">{row.utilisation.toFixed(2)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </PanelSection>
  );
}
