/**
 * @layer ui/panels
 *
 * FeatureHistoryPanel — a timeline list of `document.featureHistory` steps.
 *
 * Per step:
 *   - Toggle suppress → dispatch('set_step_suppressed', { stepId, suppressed })
 *   - Reorder up/down → dispatch('reorder_step', { stepId, newIndex })
 *   - Delete → dispatch('delete_step', { stepId })
 *   - Replay → dispatch('replay_history', {})
 * Label is shown read-only: no rename_step command exists yet (future command-author work).
 *
 * Only the suppressed toggle is inline; the other destructive actions use buttons per row.
 *
 * No business logic here — the component only gathers input and dispatches.
 * (PRIME DIRECTIVE, architecture L1, react R1)
 */

import React, { useCallback } from 'react';
import { useStore } from '@ui/store';
import type { FeatureStep } from '@core/model/types';

// ---------------------------------------------------------------------------
// FeatureStepRow — one row in the timeline
// ---------------------------------------------------------------------------

interface FeatureStepRowProps {
  step: FeatureStep;
  index: number;
  totalCount: number;
}

function FeatureStepRow({ step, index, totalCount }: FeatureStepRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const handleToggleSuppress = useCallback(() => {
    dispatch('set_step_suppressed', { stepId: step.id, suppressed: !step.suppressed });
  }, [dispatch, step.id, step.suppressed]);

  const handleMoveUp = useCallback(() => {
    if (index === 0) return;
    dispatch('reorder_step', { stepId: step.id, newIndex: index - 1 });
  }, [dispatch, step.id, index]);

  const handleMoveDown = useCallback(() => {
    if (index >= totalCount - 1) return;
    dispatch('reorder_step', { stepId: step.id, newIndex: index + 1 });
  }, [dispatch, step.id, index, totalCount]);

  const handleDelete = useCallback(() => {
    dispatch('delete_step', { stepId: step.id });
  }, [dispatch, step.id]);

  const isSuppressed = step.suppressed === true;
  const displayLabel = step.label ?? step.name;

  return (
    <li
      className={`history-step${isSuppressed ? ' history-step--suppressed' : ''}`}
      data-testid={`history-step-${step.id}`}
      aria-label={`Step ${index + 1}: ${displayLabel}${isSuppressed ? ' (suppressed)' : ''}`}
    >
      {/* Step index badge */}
      <span className="history-step-index" aria-hidden="true">
        {index + 1}
      </span>

      {/* Suppress toggle */}
      <button
        type="button"
        className={`history-suppress-btn${isSuppressed ? ' history-suppress-btn--suppressed' : ''}`}
        onClick={handleToggleSuppress}
        aria-pressed={isSuppressed}
        aria-label={
          isSuppressed ? `Restore step ${displayLabel}` : `Suppress step ${displayLabel}`
        }
        title={isSuppressed ? 'Restore (un-suppress)' : 'Suppress (skip during replay)'}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          {isSuppressed ? (
            /* Eye with a line through it */
            <>
              <ellipse cx="6" cy="6" rx="4.5" ry="3" stroke="currentColor" strokeWidth="1.2" fill="none" opacity="0.45" />
              <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </>
          ) : (
            /* Eye open */
            <>
              <ellipse cx="6" cy="6" rx="4.5" ry="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <circle cx="6" cy="6" r="1.5" fill="currentColor" />
            </>
          )}
        </svg>
      </button>

      {/* Command name + optional label */}
      <span className="history-step-name" title={step.name}>
        <span className="history-step-cmd">{step.name}</span>
        {step.label != null && (
          <span className="history-step-label">{step.label}</span>
        )}
      </span>

      {/* Reorder buttons */}
      <div className="history-step-actions">
        <button
          type="button"
          className="history-action-btn"
          onClick={handleMoveUp}
          disabled={index === 0}
          aria-label={`Move step ${displayLabel} up`}
          title="Move up"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <polyline points="2,7 5,3 8,7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="history-action-btn"
          onClick={handleMoveDown}
          disabled={index >= totalCount - 1}
          aria-label={`Move step ${displayLabel} down`}
          title="Move down"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <polyline points="2,3 5,7 8,3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="history-action-btn history-action-btn--delete"
          onClick={handleDelete}
          aria-label={`Delete step ${displayLabel}`}
          title="Delete step"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// FeatureHistoryPanel
// ---------------------------------------------------------------------------

export interface FeatureHistoryPanelProps {
  className?: string;
}

export function FeatureHistoryPanel({ className }: FeatureHistoryPanelProps): React.ReactElement {
  const featureHistory = useStore((s) => s.document.featureHistory);
  const dispatch = useStore((s) => s.dispatch);

  const handleReplay = useCallback(() => {
    dispatch('replay_history', {});
  }, [dispatch]);

  const stepCount = featureHistory.length;
  const suppressedCount = featureHistory.filter((s) => s.suppressed === true).length;

  return (
    <aside
      className={['history-panel', className].filter(Boolean).join(' ')}
      aria-label="Feature history"
    >
      <div className="history-panel-header">
        <h2 className="history-panel-title">History</h2>
        <div className="history-panel-header-actions">
          <span className="history-panel-count" aria-label={`${stepCount} steps`}>
            {stepCount}
            {suppressedCount > 0 && (
              <span className="history-panel-suppressed-badge" title={`${suppressedCount} suppressed`}>
                {` (${suppressedCount} off)`}
              </span>
            )}
          </span>
          <button
            type="button"
            className="history-replay-btn"
            onClick={handleReplay}
            disabled={stepCount === 0}
            aria-label="Replay feature history"
            title="Regenerate document from history"
          >
            Replay
          </button>
        </div>
      </div>

      {stepCount === 0 ? (
        <p className="history-empty">No history steps yet.</p>
      ) : (
        <ol className="history-step-list" aria-label="Feature history steps">
          {featureHistory.map((step, index) => (
            <FeatureStepRow
              key={step.id}
              step={step}
              index={index}
              totalCount={stepCount}
            />
          ))}
        </ol>
      )}
    </aside>
  );
}
