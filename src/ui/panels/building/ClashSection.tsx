/**
 * @layer ui/panels/building
 *
 * ClashSection — runs the read-only check_clashes command and lists hard clashes / clearance
 * violations; clicking a row selects both elements' geometry. Presentation only.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import type { Clash } from '@core/commands/building/industrial/clash';
import { PanelSection } from '@ui/panels/PanelParts';

interface ClashReport {
  readonly summary: string;
  readonly clashes: ReadonlyArray<Clash>;
}

export function ClashSection(): React.ReactElement {
  const document = useStore((s) => s.document);
  const select = useStore((s) => s.select);
  const [report, setReport] = useState<ClashReport | null>(null);

  const runCheck = (): void => {
    const result = execute(document, 'check_clashes', {});
    const data = result.data as { clashes: Clash[] } | undefined;
    setReport({ summary: result.summary, clashes: data?.clashes ?? [] });
  };

  const elements = document.building?.elements ?? {};
  const markOf = (id: string): string => elements[id]?.mark ?? id;
  const entitiesOf = (clash: Clash): string[] => [
    ...(elements[clash.a]?.entityIds ?? []),
    ...(elements[clash.b]?.entityIds ?? []),
  ];

  return (
    <PanelSection title="Clash detection" collapsible testId="building-clashes">
      <div className="building-actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={runCheck}
          data-testid="clash-check"
        >
          Check clashes
        </button>
      </div>
      {report !== null && (
        <>
          <p className="building-summary" role="status" data-testid="clash-summary">
            {report.clashes.length === 0
              ? report.summary
              : `${report.clashes.filter((clash) => clash.kind === 'hard').length} hard, ${report.clashes.filter((clash) => clash.kind === 'clearance').length} clearance`}
          </p>
          {report.clashes.length > 0 && (
            <ul className="panel__list" aria-label="Clashes">
              {report.clashes.map((clash) => (
                <li key={`${clash.kind}:${clash.a}:${clash.b}`} className="panel__row">
                  <button
                    type="button"
                    className="building-row-btn"
                    onClick={() => select(entitiesOf(clash))}
                    data-testid="clash-row"
                  >
                    <span className="chip">{clash.kind === 'hard' ? 'Hard' : 'Clearance'}</span>
                    <span className="panel__row-main">
                      {markOf(clash.a)} × {markOf(clash.b)}
                    </span>
                    <span className="panel__row-meta">
                      {Math.round(clash.depth)} {document.units}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PanelSection>
  );
}
