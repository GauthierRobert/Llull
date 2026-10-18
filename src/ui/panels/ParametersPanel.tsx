// `document.parameters` with evaluated values: set_parameter (edit / add), delete_parameter; errors in an aria-live region.

import React, { useMemo, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import type { Parameter } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { significantNumber } from '@lib/compactNumber';
import { CommitInput } from '@ui/panels/propertyFields';
import { useDraftSubmit } from '@ui/hooks/useDraftSubmit';
import { isParameterNameValid, parameterDraftOf } from '@ui/panels/parameterRules';
import { PanelEmpty, PanelHeader, DeleteButton } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import { entitiesFocus } from '@ui/panels/entityFocus';
import { entitiesDrivenBy } from '@ui/panels/parameterDrivenEntities';

function ParameterRow({ param }: { param: Parameter }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const focusItem = useFocusItem();
  const focusKey = `parameters:parameter:${param.name}`;
  const focused = useIsFocused(focusKey);
  const history = useStore((s) => s.document.featureHistory);
  const drivenIds = useMemo(
    () => entitiesDrivenBy({ ...useStore.getState().document, featureHistory: history }, [param.name]),
    [history, param.name],
  );
  const driven = drivenIds.length;

  const hasError = param.error != null;

  return (
    <li
      className={classNames('panel__row param-row', focused && 'panel__row--selected')}
      data-testid={`param-row-${param.name}`}
      aria-label={`Parameter: ${param.name}`}
    >
      <button
        type="button"
        className="param-name param-name-btn"
        aria-pressed={focused}
        aria-label={`Highlight objects driven by ${param.name}`}
        title={
          driven === 0 ? `${param.name} — drives no objects yet` : `${param.name} — click to highlight the ${driven} objects it drives`
        }
        disabled={driven === 0}
        onClick={() =>
          focusItem(
            entitiesFocus(useStore.getState().document, {
              key: focusKey,
              label: `${param.name} = ${significantNumber(param.value, 6)} — drives ${driven} ${driven === 1 ? 'object' : 'objects'}`,
              ids: drivenIds,
              note: `${param.name} = ${significantNumber(param.value, 6)}`,
            }),
          )
        }
      >
        {param.name}
        <span className="param-drives" data-testid={`param-drives-${param.name}`}>
          {driven === 0 ? '' : `→${driven}`}
        </span>
      </button>

      <CommitInput
        className={`param-expression-input${hasError ? ' input--error' : ''}`}
        value={param.expression}
        label={`Expression for parameter ${param.name}`}
        onCommit={(text) => {
          const expression = text.trim();
          if (expression !== '') dispatch('set_parameter', { name: param.name, expression });
        }}
        inputProps={{
          type: 'text',
          'aria-invalid': hasError,
          'aria-describedby': hasError ? `param-error-${param.name}` : undefined,
          title: 'Edit expression (Enter to commit, Esc to cancel)',
        }}
      />

      <span className="param-value" aria-label={`Value of ${param.name}`}>
        {hasError ? '—' : significantNumber(param.value, 6)}
      </span>

      <DeleteButton
        className="param-delete-btn"
        onDelete={() => dispatch('delete_parameter', { name: param.name })}
        label={`Delete parameter ${param.name}`}
      />

      {hasError && (
        <p id={`param-error-${param.name}`} className="param-error panel__error" role="alert" aria-live="polite">
          {param.error}
        </p>
      )}
    </li>
  );
}

function AddParameterRow(): React.ReactElement {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('');

  const draft = parameterDraftOf(name, expression);
  const nameValid = isParameterNameValid(name);

  const handleSubmit = useDraftSubmit('set_parameter', draft, () => {
    setName('');
    setExpression('');
  });

  return (
    <form className="panel__form param-add-form" onSubmit={handleSubmit} aria-label="Add new parameter" data-testid="param-add-form">
      <div className="param-add-fields">
        <input
          type="text"
          className={`param-add-name-input${!nameValid ? ' input--error' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          aria-label="New parameter name"
          autoComplete="off"
        />
        <input
          type="text"
          className="param-add-expr-input"
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
          placeholder="expression"
          aria-label="New parameter expression"
          autoComplete="off"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={draft === null || !nameValid}
          aria-label="Add parameter"
          title="Add parameter"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
    </form>
  );
}

export function ParametersPanel({ className }: { className?: string }): React.ReactElement {
  const parameters = useStore((s) => s.document.parameters);
  const paramList = Object.values(parameters);

  return (
    <aside className={classNames('panel params-panel', className)} aria-label="Parameters">
      <PanelHeader title="Parameters" count={paramList.length} countLabel={`${paramList.length} parameters`} />

      {paramList.length === 0 ? (
        <PanelEmpty icon="parameters" message="No parameters defined." hint="Name a value, then reference it from expressions." />
      ) : (
        <>
          <div className="param-columns" aria-hidden="true">
            <span>Name</span>
            <span>Expression</span>
            <span className="param-columns__value">Value</span>
          </div>
          <ul className="panel__list" aria-label="Parameter list" role="list">
            {paramList.map((param) => (
              <ParameterRow key={param.name} param={param} />
            ))}
          </ul>
        </>
      )}

      <AddParameterRow />
    </aside>
  );
}
