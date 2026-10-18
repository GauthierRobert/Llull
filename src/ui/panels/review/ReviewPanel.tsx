// Review tab: runs check_prototype (read-only), shows the readiness checklist, the findings and the Explain drawer. Reviewer statuses go out
// as set_review_disposition. While those commands are not registered the panel says so instead of dispatching. No sign-off in the MVP.

import React, { useCallback } from 'react';
import { getCommand } from '@core/commands/registry';
import { classNames } from '@ui/classNames';
import { KpiStrip, PanelEmpty, PanelHeader, PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { CHECK_COMMAND, reviewCheckCommand, runPrototypeCheck } from '@ui/services/prototypeCheck';
import { useStore } from '@ui/store';
import { ReadinessChecklist } from './ReadinessChecklist';
import { FindingsList, type DispositionChange } from './FindingsList';
import { ExplainDrawer } from './ExplainDrawer';
import { StatusMark } from './StatusMark';
import { buildChecklist, overallStatus } from './checklist';
import { findFinding, flattenFindings } from './findings';
import { isReviewStale, useReviewStore } from './reviewStore';
import { parsePrototypeReview, type CheckResult, type CheckStatus } from './reviewTypes';

const DISPOSITION_COMMAND = 'set_review_disposition';

const countOf = (checks: readonly CheckResult[], status: CheckStatus): number =>
  flattenFindings(checks).filter(({ item }) => item.status === status).length;

function useRunChecks(): () => void {
  const document = useStore((s) => s.document);
  return useCallback(() => {
    const { setBusy, setStatus, setResult } = useReviewStore.getState();
    setBusy(true);
    setStatus('');
    const source = { entities: document.entities, dynamics: document.dynamics };
    void runPrototypeCheck({}, setStatus).then((run) => {
      const review = parsePrototypeReview(run.data);
      if (review === null) setStatus(run.summary);
      else {
        setResult(review, source);
        setStatus('');
      }
      setBusy(false);
    });
  }, [document]);
}

export function ReviewPanel({ className }: { className?: string }): React.ReactElement {
  const result = useReviewStore((s) => s.result);
  const source = useReviewStore((s) => s.source);
  const busy = useReviewStore((s) => s.busy);
  const status = useReviewStore((s) => s.status);
  const explainKey = useReviewStore((s) => s.explainKey);
  const markersShown = useReviewStore((s) => s.markersShown);
  const entities = useStore((s) => s.document.entities);
  const dynamics = useStore((s) => s.document.dynamics);
  const dispatch = useStore((s) => s.dispatch);
  const run = useRunChecks();
  const checkCommand = reviewCheckCommand();
  const canCheck = checkCommand !== null;
  const canDispose = getCommand(DISPOSITION_COMMAND) !== undefined;
  const stale = isReviewStale(source, { entities, dynamics });

  const onDisposition = (change: DispositionChange): void => {
    if (!canDispose) return;
    dispatch(DISPOSITION_COMMAND, change, { onResult: ({ changed }) => changed && canCheck && run() });
  };
  const checks = result?.checks ?? [];
  const explained = explainKey === null ? undefined : findFinding(checks, explainKey);

  return (
    <aside className={classNames('panel review-panel', className)} aria-label="Review">
      <PanelHeader title="Review" count={flattenFindings(checks).length} countLabel={`${flattenFindings(checks).length} findings`}>
        {result !== null && <StatusMark status={overallStatus(checks, stale)} />}
      </PanelHeader>
      <div className="review-panel__run">
        <button type="button" className="btn btn--primary btn--sm" disabled={!canCheck || busy} onClick={run} data-testid="review-run">
          {busy ? 'Checking…' : result === null ? 'Run checks' : 'Re-run checks'}
        </button>
        {!canCheck && (
          <p className="panel__row-meta" data-testid="review-unavailable">
            Prototype checks are not available yet.
          </p>
        )}
        {canCheck && checkCommand !== CHECK_COMMAND && (
          <p className="panel__row-meta" data-testid="review-assembly-only">
            Runs the buildability check (solids, overlaps, floating parts, walls); motion and dynamics checks read “not run” here.
          </p>
        )}
      </div>
      <StatusLine text={status} testId="review-status" />
      {stale && (
        <p className="review-panel__stale" role="status" data-testid="review-stale">
          <span aria-hidden="true">◌</span> The model changed after these checks ran. Re-run to refresh them.
        </p>
      )}
      {result === null ? (
        <PanelEmpty
          icon="check"
          message="No checks run yet."
          hint="Run the checks to see whether the model is ready to build and move."
          compact
        />
      ) : (
        <>
          {result.ownerSummary !== undefined && (
            <p className="review-panel__summary" data-testid="review-summary">
              {result.ownerSummary}
            </p>
          )}
          <KpiStrip
            label="Review summary"
            items={[
              {
                key: 'review-fail',
                label: 'Failing',
                value: String(countOf(checks, 'fail')),
                tone: countOf(checks, 'fail') > 0 ? 'bad' : 'ok',
              },
              {
                key: 'review-warn',
                label: 'Warnings',
                value: String(countOf(checks, 'warn')),
                tone: countOf(checks, 'warn') > 0 ? 'warn' : 'ok',
              },
              { key: 'review-pass', label: 'Passing', value: String(countOf(checks, 'pass')), tone: 'ok' },
            ]}
          />
          <label className="loads-check review-panel__markers">
            <input
              type="checkbox"
              checked={markersShown}
              onChange={(event) => useReviewStore.getState().setMarkersShown(event.target.checked)}
              data-testid="review-markers-shown"
            />
            Mark findings on the model
          </label>
          <PanelSection title="Readiness" testId="review-readiness">
            <ReadinessChecklist rows={buildChecklist(checks, stale)} onExplain={useReviewStore.getState().openExplain} />
          </PanelSection>
          <PanelSection title="Findings" count={flattenFindings(checks).length} testId="review-findings">
            <FindingsList
              checks={checks}
              dispositionAvailable={canDispose}
              onDisposition={onDisposition}
              onExplain={useReviewStore.getState().openExplain}
            />
          </PanelSection>
        </>
      )}
      {explained !== undefined && (
        <ExplainDrawer result={explained.result} item={explained.item} onClose={() => useReviewStore.getState().openExplain(null)} />
      )}
    </aside>
  );
}
