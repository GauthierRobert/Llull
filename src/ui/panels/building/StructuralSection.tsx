/**
 * @layer ui/panels/building
 *
 * StructuralSection — roof / wind loads → read-only check_portal_frames (utilisation list, click selects
 * the element) and design_portal_frames (dispatched; up-sizes sections and bolt groups).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import type { CheckRow } from '@core/commands/building/industrial/frameCheck';
import type { BuildingModel } from '@core/model/building';
import { PanelSection } from '@ui/panels/PanelParts';

interface Report {
  readonly summary: string;
  readonly rows: ReadonlyArray<CheckRow>;
  readonly building: BuildingModel | undefined;
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

  const runCheck = (): void => {
    const result = execute(useStore.getState().document, 'check_portal_frames', loads);
    const rows = (result.data as { rows: CheckRow[] } | undefined)?.rows ?? [];
    setReport({
      summary: result.summary,
      rows: [...rows].sort((a, b) => b.utilisation - a.utilisation).slice(0, 12),
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
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={runCheck}
          data-testid="frame-check"
        >
          Check frames
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => dispatch('design_portal_frames', loads)}
          data-testid="frame-design"
        >
          Design frames
        </button>
      </div>
      {report !== null && (
        <>
          <p className="building-summary" role="status" data-testid="frame-check-summary">
            {report.summary}
          </p>
          <ul className="panel__list" aria-label="Utilisations">
            {report.rows.map((row) => (
              <li key={`${row.frame}:${row.elementId}:${row.kind}`} className="panel__row">
                <button
                  type="button"
                  className="building-row-btn"
                  onClick={() => select(building?.elements[row.elementId]?.entityIds ?? [])}
                  data-testid="frame-check-row"
                >
                  <span className="chip">{row.utilisation > 1 ? 'FAIL' : 'OK'}</span>
                  <span className="panel__row-main">
                    {row.mark} {row.kind} · {row.frame}
                  </span>
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
