/**
 * @layer ui/panels
 *
 * ConfigurationsPanel — lists `document.configurations`, lets the user create
 * new configurations, and activate an existing one.
 *
 * All mutations go through `dispatch`:
 *   - create_configuration — define or replace a named variant
 *   - activate_configuration — apply a configuration to the live document
 *
 * No business logic — the component only gathers input and dispatches.
 * (PRIME DIRECTIVE, architecture L1, react R1)
 */

import React, { useState, useCallback } from 'react';
import { useStore } from '@ui/store';
import type { Configuration } from '@core/model/types';

// ---------------------------------------------------------------------------
// ConfigurationRow — one row per existing configuration
// ---------------------------------------------------------------------------

interface ConfigurationRowProps {
  config: Configuration;
}

function ConfigurationRow({ config }: ConfigurationRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const paramEntries = Object.entries(config.parameterValues);

  const handleActivate = useCallback(() => {
    dispatch('activate_configuration', { name: config.name });
  }, [dispatch, config.name]);

  return (
    <li
      className="config-row"
      data-testid={`config-row-${config.name}`}
      aria-label={`Configuration: ${config.name}`}
    >
      <div className="config-row-header">
        <span className="config-name" title={config.name}>
          {config.name}
        </span>
        <button
          type="button"
          className="config-activate-btn"
          onClick={handleActivate}
          aria-label={`Activate configuration ${config.name}`}
          title={`Apply "${config.name}" to the document`}
        >
          Activate
        </button>
      </div>

      {paramEntries.length > 0 && (
        <ul className="config-param-list" aria-label={`Parameters for configuration ${config.name}`}>
          {paramEntries.map(([paramName, expression]) => (
            <li key={paramName} className="config-param-entry">
              <span className="config-param-name" title={paramName}>
                {paramName}
              </span>
              <span className="config-param-equals" aria-hidden="true">=</span>
              <span className="config-param-value" title={expression}>
                {expression}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// ParameterValueRow — one row in the "create" form for a parameter→expression pair
// ---------------------------------------------------------------------------

interface ParameterValueRowProps {
  index: number;
  paramName: string;
  expression: string;
  onParamNameChange: (index: number, value: string) => void;
  onExpressionChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  canRemove: boolean;
}

function ParameterValueRow({
  index,
  paramName,
  expression,
  onParamNameChange,
  onExpressionChange,
  onRemove,
  canRemove,
}: ParameterValueRowProps): React.ReactElement {
  return (
    <div className="config-pv-row" data-testid={`config-pv-row-${index}`}>
      <input
        type="text"
        className="config-pv-name-input"
        value={paramName}
        onChange={(e) => onParamNameChange(index, e.target.value)}
        placeholder="param"
        aria-label={`Parameter name for row ${index + 1}`}
        autoComplete="off"
      />
      <span className="config-pv-equals" aria-hidden="true">=</span>
      <input
        type="text"
        className="config-pv-expr-input"
        value={expression}
        onChange={(e) => onExpressionChange(index, e.target.value)}
        placeholder="expression"
        aria-label={`Expression for row ${index + 1}`}
        autoComplete="off"
      />
      {canRemove && (
        <button
          type="button"
          className="config-pv-remove-btn"
          onClick={() => onRemove(index)}
          aria-label={`Remove parameter row ${index + 1}`}
          title="Remove this parameter row"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateConfigurationForm — inline form to define a new configuration
// ---------------------------------------------------------------------------

interface PvEntry {
  paramName: string;
  expression: string;
}

function CreateConfigurationForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [configName, setConfigName] = useState('');
  const [pvRows, setPvRows] = useState<PvEntry[]>([{ paramName: '', expression: '' }]);

  const handleParamNameChange = useCallback((index: number, value: string) => {
    setPvRows((prev) => prev.map((row, i) => (i === index ? { ...row, paramName: value } : row)));
  }, []);

  const handleExpressionChange = useCallback((index: number, value: string) => {
    setPvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, expression: value } : row)),
    );
  }, []);

  const handleAddRow = useCallback(() => {
    setPvRows((prev) => [...prev, { paramName: '', expression: '' }]);
  }, []);

  const handleRemoveRow = useCallback((index: number) => {
    setPvRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const isSubmittable = useCallback((): boolean => {
    const trimName = configName.trim();
    if (trimName === '') return false;
    // Every row must have both a param name and expression, or be fully empty.
    // At least one non-empty row must exist.
    const nonEmptyRows = pvRows.filter(
      (r) => r.paramName.trim() !== '' || r.expression.trim() !== '',
    );
    if (nonEmptyRows.length === 0) return false;
    return nonEmptyRows.every((r) => r.paramName.trim() !== '' && r.expression.trim() !== '');
  }, [configName, pvRows]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!isSubmittable()) return;

      const trimmedName = configName.trim();
      const parameterValues: Record<string, string> = {};
      for (const row of pvRows) {
        const k = row.paramName.trim();
        const v = row.expression.trim();
        if (k !== '' && v !== '') {
          parameterValues[k] = v;
        }
      }

      dispatch('create_configuration', { name: trimmedName, parameterValues });
      setConfigName('');
      setPvRows([{ paramName: '', expression: '' }]);
    },
    [dispatch, configName, pvRows, isSubmittable],
  );

  return (
    <form
      className="config-create-form"
      onSubmit={handleSubmit}
      aria-label="Create new configuration"
      data-testid="config-create-form"
    >
      <div className="config-create-name-row">
        <label className="config-create-label" htmlFor="config-create-name">
          Name
        </label>
        <input
          id="config-create-name"
          type="text"
          className="config-create-name-input"
          value={configName}
          onChange={(e) => setConfigName(e.target.value)}
          placeholder="e.g. small, production_v2"
          aria-label="New configuration name"
          autoComplete="off"
        />
      </div>

      <div className="config-create-pv-section">
        <span className="config-create-pv-heading" aria-hidden="true">
          Parameters
        </span>
        {pvRows.map((row, index) => (
          <ParameterValueRow
            key={index}
            index={index}
            paramName={row.paramName}
            expression={row.expression}
            onParamNameChange={handleParamNameChange}
            onExpressionChange={handleExpressionChange}
            onRemove={handleRemoveRow}
            canRemove={pvRows.length > 1}
          />
        ))}
        <button
          type="button"
          className="config-add-row-btn"
          onClick={handleAddRow}
          aria-label="Add parameter row"
          title="Add another parameter"
        >
          + param
        </button>
      </div>

      <button
        type="submit"
        className="config-create-btn"
        disabled={!isSubmittable()}
        aria-label="Create configuration"
        title="Create configuration"
      >
        Create
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ConfigurationsPanel
// ---------------------------------------------------------------------------

export interface ConfigurationsPanelProps {
  className?: string;
}

export function ConfigurationsPanel({ className }: ConfigurationsPanelProps): React.ReactElement {
  const configurations = useStore((s) => s.document.configurations);
  const configList = Object.values(configurations).filter(
    (c): c is Configuration => c != null,
  );

  return (
    <aside
      className={['configs-panel', className].filter(Boolean).join(' ')}
      aria-label="Configurations"
    >
      <div className="configs-panel-header">
        <h2 className="configs-panel-title">Configurations</h2>
        <span className="configs-panel-count" aria-label={`${configList.length} configurations`}>
          {configList.length}
        </span>
      </div>

      {configList.length === 0 ? (
        <p className="configs-empty">No configurations defined.</p>
      ) : (
        <ul className="config-list" aria-label="Configuration list" role="list">
          {configList.map((config) => (
            <ConfigurationRow key={config.name} config={config} />
          ))}
        </ul>
      )}

      <div className="configs-panel-footer">
        <CreateConfigurationForm />
      </div>
    </aside>
  );
}
