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
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';

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
      className={`panel__row history-step${isSuppressed ? ' history-step--suppressed' : ''}`}
      data-testid={`history-step-${step.id}`}
      aria-label={`Step ${index + 1}: ${displayLabel}${isSuppressed ? ' (suppressed)' : ''}`}
    >
      <span className="history-step-index" aria-hidden="true">
        {index + 1}
      </span>

      <span className="history-step-name" title={step.name}>
        <span className="history-step-cmd">{step.name}</span>
        {step.label != null && <span className="history-step-label">{step.label}</span>}
      </span>

      {isSuppressed && <span className="chip chip--warning">off</span>}

      <div className="panel__row-actions">
        <button
          type="button"
          className="icon-btn"
          onClick={handleMoveUp}
          disabled={index === 0}
          aria-label={`Move step ${displayLabel} up`}
          title="Move up"
        >
          <Icon name="arrowUp" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={handleMoveDown}
          disabled={index >= totalCount - 1}
          aria-label={`Move step ${displayLabel} down`}
          title="Move down"
        >
          <Icon name="arrowDown" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--danger"
          onClick={handleDelete}
          aria-label={`Delete step ${displayLabel}`}
          title="Delete step"
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      <button
        type="button"
        className={`icon-btn history-suppress-btn${isSuppressed ? ' history-suppress-btn--suppressed' : ''}`}
        onClick={handleToggleSuppress}
        aria-pressed={isSuppressed}
        aria-label={isSuppressed ? `Restore step ${displayLabel}` : `Suppress step ${displayLabel}`}
        title={isSuppressed ? 'Restore (un-suppress)' : 'Suppress (skip during replay)'}
      >
        <Icon name={isSuppressed ? 'eyeOff' : 'eye'} size={14} />
      </button>
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
      className={['panel history-panel', className].filter(Boolean).join(' ')}
      aria-label="Feature history"
    >
      <PanelHeader title="History" count={stepCount} countLabel={`${stepCount} steps`}>
        {suppressedCount > 0 && (
          <span className="chip chip--warning" title={`${suppressedCount} suppressed`}>
            {suppressedCount} off
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handleReplay}
          disabled={stepCount === 0}
          aria-label="Replay feature history"
          title="Regenerate document from history"
        >
          <Icon name="reset" size={12} />
          Replay
        </button>
      </PanelHeader>

      {stepCount === 0 ? (
        <PanelEmpty
          icon="history"
          message="No history steps yet."
          hint="Every command you run is recorded here as an editable step."
        />
      ) : (
        <ol className="panel__list" aria-label="Feature history steps">
          {featureHistory.map((step, index) => (
            <FeatureStepRow key={step.id} step={step} index={index} totalCount={stepCount} />
          ))}
        </ol>
      )}
    </aside>
  );
}
