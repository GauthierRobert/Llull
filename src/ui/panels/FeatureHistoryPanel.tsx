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

import React from 'react';
import { useStore } from '@ui/store';
import type { FeatureStep } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, IconButton } from '@ui/panels/PanelParts';

interface FeatureStepRowProps {
  step: FeatureStep;
  index: number;
  totalCount: number;
}

function FeatureStepRow({ step, index, totalCount }: FeatureStepRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

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
        <IconButton
          icon="arrowUp"
          onClick={() => dispatch('reorder_step', { stepId: step.id, newIndex: index - 1 })}
          disabled={index === 0}
          label={`Move step ${displayLabel} up`}
          title="Move up"
        />
        <IconButton
          icon="arrowDown"
          onClick={() => dispatch('reorder_step', { stepId: step.id, newIndex: index + 1 })}
          disabled={index >= totalCount - 1}
          label={`Move step ${displayLabel} down`}
          title="Move down"
        />
        <IconButton
          icon="trash"
          danger
          onClick={() => dispatch('delete_step', { stepId: step.id })}
          label={`Delete step ${displayLabel}`}
          title="Delete step"
        />
      </div>

      <button
        type="button"
        className={`icon-btn history-suppress-btn${isSuppressed ? ' history-suppress-btn--suppressed' : ''}`}
        onClick={() =>
          dispatch('set_step_suppressed', { stepId: step.id, suppressed: !step.suppressed })
        }
        aria-pressed={isSuppressed}
        aria-label={isSuppressed ? `Restore step ${displayLabel}` : `Suppress step ${displayLabel}`}
        title={isSuppressed ? 'Restore (un-suppress)' : 'Suppress (skip during replay)'}
      >
        <Icon name={isSuppressed ? 'eyeOff' : 'eye'} size={14} />
      </button>
    </li>
  );
}

interface FeatureHistoryPanelProps {
  className?: string;
}

export function FeatureHistoryPanel({ className }: FeatureHistoryPanelProps): React.ReactElement {
  const featureHistory = useStore((s) => s.document.featureHistory);
  const dispatch = useStore((s) => s.dispatch);

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
          onClick={() => dispatch('replay_history', {})}
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
