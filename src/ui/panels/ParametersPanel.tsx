/**
 * @layer ui/panels
 *
 * ParametersPanel — lists `document.parameters` with their evaluated value; edits expressions
 * (set_parameter), adds parameters (set_parameter) and deletes them (delete_parameter).
 * A parameter `error` is shown under its row in an aria-live region.
 */

import React, { useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import type { Parameter } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, IconButton } from '@ui/panels/PanelParts';

interface ParameterRowProps {
  param: Parameter;
}

function ParameterRow({ param }: ParameterRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [editingExpression, setEditingExpression] = useState<string | null>(null);
  /** Set by Escape so the blur that follows discards the edit instead of committing it. */
  const cancelled = useRef(false);

  const commitExpression = (): void => {
    const trimmed = editingExpression?.trim() ?? '';
    if (!cancelled.current && trimmed !== '' && editingExpression !== param.expression) {
      dispatch('set_parameter', { name: param.name, expression: trimmed });
    }
    setEditingExpression(null);
  };

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
        type="text"
        className={`param-expression-input${hasError ? ' input--error' : ''}`}
        value={displayExpression}
        onFocus={() => {
          cancelled.current = false;
          setEditingExpression(param.expression);
        }}
        onChange={(e) => setEditingExpression(e.target.value)}
        onBlur={commitExpression}
        onKeyDown={(e) => {
          // Blur commits (once); Escape flags the blur as a cancel.
          if (e.key === 'Escape') cancelled.current = true;
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
        }}
        aria-label={`Expression for parameter ${param.name}`}
        aria-invalid={hasError}
        aria-describedby={hasError ? `param-error-${param.name}` : undefined}
        title="Edit expression (Enter to commit, Esc to cancel)"
      />

      <span className="param-value" aria-label={`Value of ${param.name}`}>
        {hasError ? '—' : param.value.toPrecision(6).replace(/\.?0+$/, '')}
      </span>

      <IconButton
        icon="trash"
        danger
        className="param-delete-btn"
        onClick={() => dispatch('delete_parameter', { name: param.name })}
        label={`Delete parameter ${param.name}`}
        title={`Delete parameter ${param.name}`}
      />

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

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedExpr = expression.trim();
    if (trimmedName === '' || trimmedExpr === '') return;
    dispatch('set_parameter', { name: trimmedName, expression: trimmedExpr });
    setName('');
    setExpression('');
  };

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
  const paramList = Object.values(parameters);

  return (
    <aside className={classNames('panel params-panel', className)} aria-label="Parameters">
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
