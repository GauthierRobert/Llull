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

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { Configuration } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, IconButton } from '@ui/panels/PanelParts';

interface ConfigurationRowProps {
  config: Configuration;
}

function ConfigurationRow({ config }: ConfigurationRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const paramEntries = Object.entries(config.parameterValues);

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
          className="btn btn--ghost btn--sm"
          onClick={() => dispatch('activate_configuration', { name: config.name })}
          aria-label={`Activate configuration ${config.name}`}
          title={`Apply "${config.name}" to the document`}
        >
          <Icon name="play" size={10} />
          Activate
        </button>
      </div>

      {paramEntries.length > 0 && (
        <ul
          className="config-param-list"
          aria-label={`Parameters for configuration ${config.name}`}
        >
          {paramEntries.map(([paramName, expression]) => (
            <li key={paramName} className="config-param-entry">
              <span className="config-param-name" title={paramName}>
                {paramName}
              </span>
              <span className="config-param-equals" aria-hidden="true">
                =
              </span>
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
      <span className="config-pv-equals" aria-hidden="true">
        =
      </span>
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
        <IconButton
          icon="close"
          className="config-pv-remove-btn"
          size={12}
          onClick={() => onRemove(index)}
          label={`Remove parameter row ${index + 1}`}
          title="Remove this parameter row"
        />
      )}
    </div>
  );
}

interface PvEntry {
  paramName: string;
  expression: string;
}

function CreateConfigurationForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [configName, setConfigName] = useState('');
  const [pvRows, setPvRows] = useState<PvEntry[]>([{ paramName: '', expression: '' }]);

  const updateRow = (index: number, patch: Partial<PvEntry>): void =>
    setPvRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const handleParamNameChange = (index: number, value: string): void =>
    updateRow(index, { paramName: value });
  const handleExpressionChange = (index: number, value: string): void =>
    updateRow(index, { expression: value });
  const handleAddRow = (): void =>
    setPvRows((prev) => [...prev, { paramName: '', expression: '' }]);
  const handleRemoveRow = (index: number): void =>
    setPvRows((prev) => prev.filter((_, i) => i !== index));

  const nonEmptyRows = pvRows.filter(
    (r) => r.paramName.trim() !== '' || r.expression.trim() !== '',
  );
  const isSubmittable =
    configName.trim() !== '' &&
    nonEmptyRows.length > 0 &&
    nonEmptyRows.every((r) => r.paramName.trim() !== '' && r.expression.trim() !== '');

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!isSubmittable) return;
    const parameterValues: Record<string, string> = {};
    for (const row of nonEmptyRows) parameterValues[row.paramName.trim()] = row.expression.trim();
    dispatch('create_configuration', { name: configName.trim(), parameterValues });
    setConfigName('');
    setPvRows([{ paramName: '', expression: '' }]);
  };

  return (
    <form
      className="panel__form config-create-form"
      onSubmit={handleSubmit}
      aria-label="Create new configuration"
      data-testid="config-create-form"
    >
      <span className="panel__form-title" aria-hidden="true">
        New configuration
      </span>
      <div className="field">
        <label className="field__label" htmlFor="config-create-name">
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
        <span className="panel__form-title" aria-hidden="true">
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
          className="btn btn--ghost btn--sm config-add-row-btn"
          onClick={handleAddRow}
          aria-label="Add parameter row"
          title="Add another parameter"
        >
          <Icon name="plus" size={12} />
          Parameter
        </button>
      </div>

      <button
        type="submit"
        className="btn btn--primary btn--block"
        disabled={!isSubmittable}
        aria-label="Create configuration"
        title="Create configuration"
      >
        Create
      </button>
    </form>
  );
}

interface ConfigurationsPanelProps {
  className?: string;
}

export function ConfigurationsPanel({ className }: ConfigurationsPanelProps): React.ReactElement {
  const configurations = useStore((s) => s.document.configurations);
  const configList = Object.values(configurations).filter((c): c is Configuration => c != null);

  return (
    <aside
      className={['panel configs-panel', className].filter(Boolean).join(' ')}
      aria-label="Configurations"
    >
      <PanelHeader
        title="Configurations"
        count={configList.length}
        countLabel={`${configList.length} configurations`}
      />

      {configList.length === 0 ? (
        <PanelEmpty
          icon="configurations"
          message="No configurations defined."
          hint="A configuration is a named set of parameter values."
        />
      ) : (
        <ul className="config-list" aria-label="Configuration list" role="list">
          {configList.map((config) => (
            <ConfigurationRow key={config.name} config={config} />
          ))}
        </ul>
      )}

      <CreateConfigurationForm />
    </aside>
  );
}
