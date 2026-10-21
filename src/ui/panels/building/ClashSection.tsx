// Read-only check_clashes: hard clashes / clearance violations; a row selects both elements' geometry.

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { runQuery } from '@ui/services/localQuery';
import type { Clash, BuildingModel } from '@aec/index';
import { toMetres } from '@core/model/units';
import { KpiStrip, ListRow, PanelSection, StatusChip, StatusLine } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useFocusStore } from '@ui/store/focusStore';
import { clashFocus } from './structuralFocus';
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
  const document = useDocumentWithoutSelection();
  const focusItem = useFocusItem();
  const focusKey = useFocusStore((s) => s.focus?.key);
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
            <>
              <KpiStrip
                label="Clash summary"
                items={[
                  {
                    key: 'hard',
                    label: 'Hard clashes',
                    value: String(report.clashes.filter((clash) => clash.kind === 'hard').length),
                    tone: 'bad',
                  },
                  {
                    key: 'clearance',
                    label: 'Clearance',
                    value: String(report.clashes.filter((clash) => clash.kind === 'clearance').length),
                    tone: 'warn',
                  },
                ]}
              />
              <ul className="panel__list" aria-label="Clashes">
                {report.clashes.map((clash) => {
                  const key = `${clash.kind}:${clash.a}:${clash.b}`;
                  const focus = clashFocus(
                    document,
                    key,
                    `${markOf(clash.a)} × ${markOf(clash.b)}`,
                    `${millimetres(clash.depth)} mm`,
                    clash.a,
                    clash.b,
                  );
                  return (
                    <ListRow
                      key={key}
                      buttonTestId="clash-row"
                      swatch={clash.kind === 'hard' ? '#ff4d4f' : '#ffb300'}
                      selected={focusKey === focus.key}
                      onSelect={() => focusItem(focus)}
                    >
                      <StatusChip tone={clash.kind === 'hard' ? 'bad' : 'warn'} text={clash.kind === 'hard' ? 'Hard' : 'Clearance'} />
                      <span className="panel__row-main">
                        {markOf(clash.a)} × {markOf(clash.b)}
                      </span>
                      <span className="panel__row-meta">{millimetres(clash.depth)} mm</span>
                    </ListRow>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </PanelSection>
  );
}
