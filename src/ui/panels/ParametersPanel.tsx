/**
 * @layer ui/panels
 *
 * ParametersPanel — lists `document.parameters`, supports editing expressions,
 * adding new parameters, and deleting existing ones.
 *
 * All mutations go through `dispatch`:
 *   - set_parameter  — create or update a parameter expression
 *   - delete_parameter — remove a parameter
 *
 * Shows the evaluated `value` alongside the `expression`. When a parameter has
 * an `error` the error message is displayed in red with an aria-live region.
 *
 * No business logic here — the component only gathers input and dispatches.
 * (PRIME DIRECTIVE, architecture L1, react R1)
 */

import React, { useState, useCallback, useRef } from 'react';
import { useStore } from '@ui/store';
import type { Parameter } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';

interface ParameterRowProps {
  param: Parameter;
}

function ParameterRow({ param }: ParameterRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [editingExpression, setEditingExpression] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleExpressionFocus = useCallback(() => {
    setEditingExpression(param.expression);
  }, [param.expression]);

  const handleExpressionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingExpression(e.target.value);
  }, []);

  const commitExpression = useCallback(() => {
    if (
      editingExpression !== null &&
      editingExpression.trim() !== '' &&
      editingExpression !== param.expression
    ) {
      dispatch('set_parameter', { name: param.name, expression: editingExpression.trim() });
    }
    setEditingExpression(null);
  }, [dispatch, editingExpression, param.expression, param.name]);

  const handleExpressionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitExpression();
        inputRef.current?.blur();
      } else if (e.key === 'Escape') {
        setEditingExpression(null);
        inputRef.current?.blur();
      }
    },
    [commitExpression],
  );

  const handleDelete = useCallback(() => {
    dispatch('delete_parameter', { name: param.name });
  }, [dispatch, param.name]);

  const displayExpression = editingExpression !== null ? editingExpression : param.expression;
  const hasError = param.error != null;

  return (
    <li
      className="panel__row param-row"
      data-testid={`param-row-${param.name}`}
      aria-label={`Parameter: ${param.name}`}
    >
      <span className="param-name" title={param.name}>
        {param.name}
      </span>

      <input
        ref={inputRef}
        type="text"
        className={`param-expression-input${hasError ? ' input--error' : ''}`}
        value={displayExpression}
        onFocus={handleExpressionFocus}
        onChange={handleExpressionChange}
        onBlur={commitExpression}
        onKeyDown={handleExpressionKeyDown}
        aria-label={`Expression for parameter ${param.name}`}
        aria-invalid={hasError}
        aria-describedby={hasError ? `param-error-${param.name}` : undefined}
        title="Edit expression (Enter to commit, Esc to cancel)"
      />

      <span className="param-value" aria-label={`Value of ${param.name}`}>
        {hasError ? '—' : param.value.toPrecision(6).replace(/\.?0+$/, '')}
      </span>

      <button
        type="button"
        className="icon-btn icon-btn--danger param-delete-btn"
        onClick={handleDelete}
        aria-label={`Delete parameter ${param.name}`}
        title={`Delete parameter ${param.name}`}
      >
        <Icon name="trash" size={13} />
      </button>

      {hasError && (
        <p
          id={`param-error-${param.name}`}
          className="param-error panel__error"
          role="alert"
          aria-live="polite"
        >
          {param.error}
        </p>
      )}
    </li>
  );
}

function AddParameterRow(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedName = name.trim();
      const trimmedExpr = expression.trim();
      if (trimmedName === '' || trimmedExpr === '') return;
      dispatch('set_parameter', { name: trimmedName, expression: trimmedExpr });
      setName('');
      setExpression('');
    },
    [dispatch, name, expression],
  );

  const nameValid = name.trim() === '' || /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim());

  return (
    <form
      className="panel__form param-add-form"
      onSubmit={handleSubmit}
      aria-label="Add new parameter"
      data-testid="param-add-form"
    >
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
          disabled={name.trim() === '' || expression.trim() === '' || !nameValid}
          aria-label="Add parameter"
          title="Add parameter"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
    </form>
  );
}

interface ParametersPanelProps {
  className?: string;
}

export function ParametersPanel({ className }: ParametersPanelProps): React.ReactElement {
  const parameters = useStore((s) => s.document.parameters);
  const paramList = Object.values(parameters).filter((p): p is Parameter => p != null);

  return (
    <aside
      className={['panel params-panel', className].filter(Boolean).join(' ')}
      aria-label="Parameters"
    >
      <PanelHeader
        title="Parameters"
        count={paramList.length}
        countLabel={`${paramList.length} parameters`}
      />

      {paramList.length === 0 ? (
        <PanelEmpty
          icon="parameters"
          message="No parameters defined."
          hint="Name a value, then reference it from expressions."
        />
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
