// `document.featureHistory` timeline: set_step_suppressed, reorder_step, delete_step, replay_history, edit_step_params
// (a refused edit keeps the form open with the summary). Labels are read-only (no rename_step command).

import React, { memo, useMemo, useState } from 'react';
import { getCommand } from '@core/commands/registry';
import { CommandParamForm } from '@ui/components/commandPalette/CommandParamForm';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import type { FeatureStep } from '@core/model/types';
import { useDispatchThen } from '@ui/hooks/useDispatchThen';
import { Icon } from '@ui/components/Icon';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import { stepEntityIds } from '@ui/panels/stepEntities';
import { entitiesFocus } from '@ui/panels/entityFocus';
import { PanelEmpty, PanelHeader, IconButton, DeleteButton } from '@ui/panels/PanelParts';

const FeatureStepRow = memo(function FeatureStepRow({
  step,
  index,
  totalCount,
}: {
  step: FeatureStep;
  index: number;
  totalCount: number;
}): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const dispatchThen = useDispatchThen();
  const command = getCommand(step.name);
  const focusItem = useFocusItem();
  const focusKey = `history:step:${step.id}`;
  const focused = useIsFocused(focusKey);
  const entities = useStore((s) => s.document.entities);
  const stepIds = useMemo(() => stepEntityIds(step, entities), [step, entities]);
  const liveAffected = stepIds.length;

  const isSuppressed = step.suppressed === true;
  const displayLabel = step.label ?? step.name;

  const submitEdit = (params: Record<string, unknown>): void => {
    setRefusal(null);
    dispatchThen('edit_step_params', { stepId: step.id, params }, () => setEditing(false), setRefusal);
  };

  return (
    <>
      <li
        className={classNames(
          'panel__row panel__row--overlay-actions history-step',
          isSuppressed && 'history-step--suppressed',
          focused && 'panel__row--selected',
        )}
        data-testid={`history-step-${step.id}`}
        aria-label={`Step ${index + 1}: ${displayLabel}${isSuppressed ? ' (suppressed)' : ''}`}
      >
        <button
          type="button"
          className="history-step-focus"
          aria-pressed={focused}
          aria-label={`Highlight objects made by step ${index + 1}: ${displayLabel}`}
          title={liveAffected === 0 ? 'This step leaves no objects in the model' : 'Highlight the objects this step made or changed'}
          disabled={liveAffected === 0 || isSuppressed}
          onClick={() =>
            focusItem(
              entitiesFocus(useStore.getState().document, {
                key: focusKey,
                label: `Step ${index + 1}: ${displayLabel} — ${liveAffected} ${liveAffected === 1 ? 'object' : 'objects'}`,
                ids: stepIds,
              }),
            )
          }
        >
          <span className="history-step-index" aria-hidden="true">
            {index + 1}
          </span>

          <span className="history-step-name" title={step.name}>
            <span className="history-step-cmd">{step.name}</span>
            {step.label != null && <span className="history-step-label">{step.label}</span>}
          </span>

          {liveAffected > 0 && !isSuppressed && (
            <span className="history-step-count" title={`${liveAffected} objects`}>
              {liveAffected}
            </span>
          )}
        </button>

        {isSuppressed && <span className="chip chip--warning">off</span>}

        <div className="panel__row-actions">
          {command !== undefined && (
            <IconButton
              icon="parameters"
              onClick={() => {
                setRefusal(null);
                setEditing((open) => !open);
              }}
              pressed={editing}
              label={`Edit parameters of step ${displayLabel}`}
              title="Edit parameters"
            />
          )}
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
          <DeleteButton
            onDelete={() => dispatch('delete_step', { stepId: step.id })}
            label={`Delete step ${displayLabel}`}
            title="Delete step"
          />
        </div>

        <button
          type="button"
          className={`icon-btn history-suppress-btn${isSuppressed ? ' history-suppress-btn--suppressed' : ''}`}
          onClick={() => dispatch('set_step_suppressed', { stepId: step.id, suppressed: !step.suppressed })}
          aria-pressed={isSuppressed}
          aria-label={isSuppressed ? `Restore step ${displayLabel}` : `Suppress step ${displayLabel}`}
          title={isSuppressed ? 'Restore (un-suppress)' : 'Suppress (skip during replay)'}
        >
          <Icon name={isSuppressed ? 'eyeOff' : 'eye'} size={14} />
        </button>
      </li>
      {editing && command !== undefined && (
        <li className="history-step-editor" data-testid={`history-edit-${step.id}`}>
          <CommandParamForm
            command={command}
            initialParams={step.params as Record<string, unknown>}
            submitLabel="Apply"
            backLabel="Cancel editing"
            statusMessage={refusal}
            onBack={() => setEditing(false)}
            onSubmit={submitEdit}
          />
        </li>
      )}
    </>
  );
});

export function FeatureHistoryPanel({ className }: { className?: string }): React.ReactElement {
  const featureHistory = useStore((s) => s.document.featureHistory);
  const dispatch = useStore((s) => s.dispatch);

  const stepCount = featureHistory.length;
  const suppressedCount = featureHistory.filter((s) => s.suppressed === true).length;

  return (
    <aside className={classNames('panel history-panel', className)} aria-label="Feature history">
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
        <PanelEmpty icon="history" message="No history steps yet." hint="Every command you run is recorded here as an editable step." />
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
