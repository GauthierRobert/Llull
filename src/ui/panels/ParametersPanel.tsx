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

// ---------------------------------------------------------------------------
// ParameterRow — one row per existing parameter
// ---------------------------------------------------------------------------

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
    if (editingExpression !== null && editingExpression.trim() !== '' && editingExpression !== param.expression) {
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
      className="param-row"
      data-testid={`param-row-${param.name}`}
      aria-label={`Parameter: ${param.name}`}
    >
      <span className="param-name" title={param.name}>
        {param.name}
      </span>

      <input
        ref={inputRef}
        type="text"
        className={`param-expression-input${hasError ? ' param-expression-input--error' : ''}`}
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
        className="param-delete-btn"
        onClick={handleDelete}
        aria-label={`Delete parameter ${param.name}`}
        title={`Delete parameter ${param.name}`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {hasError && (
        <p
          id={`param-error-${param.name}`}
          className="param-error"
          role="alert"
          aria-live="polite"
        >
          {param.error}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// AddParameterRow — inline form to create a new parameter
// ---------------------------------------------------------------------------

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
      className="param-add-form"
      onSubmit={handleSubmit}
      aria-label="Add new parameter"
      data-testid="param-add-form"
    >
      <input
        type="text"
        className={`param-add-name-input${!nameValid ? ' param-expression-input--error' : ''}`}
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
        className="param-add-btn"
        disabled={name.trim() === '' || expression.trim() === '' || !nameValid}
        aria-label="Add parameter"
        title="Add parameter"
      >
        Add
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ParametersPanel
// ---------------------------------------------------------------------------

export interface ParametersPanelProps {
  className?: string;
}

export function ParametersPanel({ className }: ParametersPanelProps): React.ReactElement {
  const parameters = useStore((s) => s.document.parameters);
  const paramList = Object.values(parameters).filter((p): p is Parameter => p != null);

  return (
    <aside
      className={['params-panel', className].filter(Boolean).join(' ')}
      aria-label="Parameters"
    >
      <div className="params-panel-header">
        <h2 className="params-panel-title">Parameters</h2>
        <span className="params-panel-count" aria-label={`${paramList.length} parameters`}>
          {paramList.length}
        </span>
      </div>

      {paramList.length === 0 ? (
        <p className="params-empty">No parameters defined.</p>
      ) : (
        <ul className="param-list" aria-label="Parameter list" role="list">
          <li className="param-list-header" aria-hidden="true">
            <span className="param-col-name">Name</span>
            <span className="param-col-expr">Expression</span>
            <span className="param-col-value">Value</span>
            <span className="param-col-actions" />
          </li>
          {paramList.map((param) => (
            <ParameterRow key={param.name} param={param} />
          ))}
        </ul>
      )}

      <div className="params-panel-footer">
        <AddParameterRow />
      </div>
    </aside>
  );
}
