/**
 * @layer ui/panels/building
 *
 * ClashSection — runs the read-only check_clashes command and lists hard clashes / clearance
 * violations; clicking a row selects both elements' geometry. Presentation only.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';
import type { Clash } from '@aec/industrial/clash/clash';
import { toMetres } from '@core/model/units';
import type { BuildingModel } from '@core/model/building';
import { ListRow, PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { isClashData } from '@ui/resultData';

interface ClashReport {
  readonly summary: string;
  readonly clashes: ReadonlyArray<Clash>;
  /** Building the report was computed for; a later edit makes it stale. */
  readonly building: BuildingModel | undefined;
}

export function ClashSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const select = useStore((s) => s.select);
  const [computed, setReport] = useState<ClashReport | null>(null);
  const report = computed !== null && computed.building === building ? computed : null;

  const runCheck = (): void => {
    const result = runQuery('check_clashes');
    const clashes = isClashData(result.data) ? result.data.clashes : [];
    setReport({ summary: result.summary, clashes, building });
  };

  const millimetres = (depth: number): number => Math.round(toMetres({ units }, depth) * 1000);
  const elements = building?.elements ?? {};
  const markOf = (id: string): string => elements[id]?.mark ?? id;
  const entitiesOf = (clash: Clash): string[] => [...(elements[clash.a]?.entityIds ?? []), ...(elements[clash.b]?.entityIds ?? [])];

  return (
    <PanelSection
      title="Clash detection"
      hint="Find elements that overlap (e.g. a pipe through a beam). Read-only."
      collapsible
      testId="building-clashes"
    >
      <div className="building-actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={runCheck} data-testid="clash-check">
          Check clashes
        </button>
      </div>
      {report !== null && (
        <>
          <StatusLine
            text={
              report.clashes.length === 0
                ? report.summary
                : `${report.clashes.filter((clash) => clash.kind === 'hard').length} hard, ${report.clashes.filter((clash) => clash.kind === 'clearance').length} clearance`
            }
            testId="clash-summary"
          />
          {report.clashes.length > 0 && (
            <ul className="panel__list" aria-label="Clashes">
              {report.clashes.map((clash) => (
                <ListRow key={`${clash.kind}:${clash.a}:${clash.b}`} buttonTestId="clash-row" onSelect={() => select(entitiesOf(clash))}>
                  <span className="chip">{clash.kind === 'hard' ? 'Hard' : 'Clearance'}</span>
                  <span className="panel__row-main">
                    {markOf(clash.a)} × {markOf(clash.b)}
                  </span>
                  <span className="panel__row-meta">{millimetres(clash.depth)} mm</span>
                </ListRow>
              ))}
            </ul>
          )}
        </>
      )}
    </PanelSection>
  );
}
