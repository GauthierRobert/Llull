// Findings panel (07 §7.3): code, value against limit, source and remediation of every finding of check_sheet_metal / check_machining, the
// unverified marker, the standing "review required" banner and the provenance popover. Findings are facts; nothing here approves them.

import React from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { ProvenancePopover } from '@ui/panels/ProvenancePopover';
import { ReviewBanner } from '@ui/panels/ReviewBanner';
import { useReadOnlyQuery } from '@ui/panels/useReadOnlyQuery';
import { parseCheck, type FtrFindingView } from './ftrData';

const GLYPH: Readonly<Record<FtrFindingView['severity'], string>> = { fail: '✖', warn: '▲', info: '○' };

function formatMeasure(finding: FtrFindingView): string | null {
  if (finding.value === undefined && finding.limit === undefined) return null;
  const unit = finding.unit === undefined ? '' : ` ${finding.unit}`;
  const value = finding.value === undefined ? '—' : `${finding.value}${unit}`;
  return finding.limit === undefined ? value : `${value} (limit ${finding.limit}${unit})`;
}

function FindingRow({ finding }: { finding: FtrFindingView }): React.ReactElement {
  const measure = formatMeasure(finding);
  return (
    <li className="finding" data-testid={`ftr-finding-${finding.code}`}>
      <div className="finding__head">
        <span className={`status-mark status-mark--${finding.severity === 'info' ? 'not_run' : finding.severity}`}>
          <span className="status-mark__glyph" aria-hidden="true">
            {GLYPH[finding.severity]}
          </span>
          <span className="status-mark__word">{finding.severity}</span>
        </span>
        <code className="finding__code">{finding.code}</code>
        {finding.code === 'FTR_UNVERIFIED_DATA' && <span className="finding__badge">unverified</span>}
      </div>
      <p className="finding__meta">
        {finding.ids.length > 0 && <span>{finding.ids.join(', ')}</span>}
        {measure !== null && <span>{measure}</span>}
        {finding.source !== undefined && <span title="Source">{finding.source}</span>}
      </p>
      <p className="finding__remediation">{finding.remediation}</p>
    </li>
  );
}

export function FtrFindingsSection({
  partId,
  command,
}: {
  partId: string;
  command: 'check_sheet_metal' | 'check_machining';
}): React.ReactElement {
  const check = useReadOnlyQuery(command, parseCheck);
  const view = check.view;
  return (
    <PanelSection title="Findings" {...(view === null ? {} : { count: view.findings.length })} testId="mfg-findings">
      <div className="mfg__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => check.run({ id: partId })} data-testid="ftr-run">
          {view === null ? 'Run checks' : 'Re-run checks'}
        </button>
      </div>
      {view === null ? (
        <p className="panel__row-meta" role="status" data-testid="ftr-status">
          {check.summary === '' ? 'No checks run yet.' : check.summary}
        </p>
      ) : (
        <>
          {check.stale && (
            <p className="review-panel__stale" role="status" data-testid="ftr-stale">
              <span aria-hidden="true">◌</span> The model changed after these checks ran. Re-run to refresh them.
            </p>
          )}
          {view.reviewRequired && (
            <ReviewBanner {...(view.reviewReason === undefined ? {} : { reason: view.reviewReason })} unverified={view.unverified} />
          )}
          <p className="mfg__figures" data-testid="ftr-overall">
            Overall: <strong>{view.status}</strong>
            {view.rulesSkipped.length > 0 && ` · skipped ${view.rulesSkipped.join(', ')}`}
          </p>
          <ul className="findings__list" data-testid="ftr-findings-list">
            {view.findings.map((finding, index) => (
              <FindingRow key={`${finding.code}-${index}`} finding={finding} />
            ))}
          </ul>
          <ProvenancePopover entries={view.provenance} testId="ftr-provenance" />
        </>
      )}
    </PanelSection>
  );
}
