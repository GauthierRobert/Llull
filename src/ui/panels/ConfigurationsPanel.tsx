/**
 * @layer ui/panels
 *
 * ConfigurationsPanel — lists `document.configurations`; creates (create_configuration) and
 * activates (activate_configuration) them.
 */

import React, { useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import type { Configuration } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { useDispatchThen } from '@ui/hooks/useDispatchThen';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { configurationDraftOf, isConfigurationActive } from '@ui/panels/configurationRules';
import { PanelEmpty, PanelHeader, IconButton } from '@ui/panels/PanelParts';

interface ConfigurationRowProps {
  config: Configuration;
  /** True when every parameter already holds this configuration's expression. */
  active: boolean;
}

function ConfigurationRow({ config, active }: ConfigurationRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const paramEntries = Object.entries(config.parameterValues);

  return (
    <li
      className="config-row"
      data-testid={`config-row-${config.name}`}
      aria-label={`Configuration: ${config.name}${active ? ' (active)' : ''}`}
      aria-current={active ? 'true' : undefined}
    >
      <div className="config-row-header">
        <span className="config-name" title={config.name}>
          {config.name}
        </span>
        {active && <span className="chip chip--accent">active</span>}
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

interface PvEntry {
  /** Stable React key — rows can be removed from the middle. */
  rowId: number;
  paramName: string;
  expression: string;
}

interface ParameterValueRowProps {
  index: number;
  entry: PvEntry;
  onChange: (index: number, patch: Partial<PvEntry>) => void;
  onRemove: (index: number) => void;
  canRemove: boolean;
}

function ParameterValueRow({
  index,
  entry,
  onChange,
  onRemove,
  canRemove,
}: ParameterValueRowProps): React.ReactElement {
  return (
    <div className="config-pv-row" data-testid={`config-pv-row-${index}`}>
      <input
        type="text"
        className="config-pv-name-input"
        value={entry.paramName}
        onChange={(e) => onChange(index, { paramName: e.target.value })}
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
        value={entry.expression}
        onChange={(e) => onChange(index, { expression: e.target.value })}
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

const emptyRow = (rowId: number): PvEntry => ({ rowId, paramName: '', expression: '' });

function CreateConfigurationForm(): React.ReactElement {
  const [configName, setConfigName] = useState('');
  const nextRowId = useRef(1);
  const newRow = (): PvEntry => emptyRow(nextRowId.current++);
  const [pvRows, setPvRows] = useState<PvEntry[]>(() => [emptyRow(0)]);

  const updateRow = (index: number, patch: Partial<PvEntry>): void =>
    setPvRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const handleAddRow = (): void => setPvRows((prev) => [...prev, newRow()]);
  const handleRemoveRow = (index: number): void =>
    setPvRows((prev) => prev.filter((_, i) => i !== index));

  const dispatchThen = useDispatchThen();
  const draft = configurationDraftOf(configName, pvRows);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (draft === null) return;
    dispatchThen('create_configuration', draft, () => {
      setConfigName('');
      setPvRows([newRow()]);
    });
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
      <LabeledInput
        label="Configuration name"
        type="text"
        value={configName}
        onChange={setConfigName}
        placeholder="e.g. small, production_v2"
        inputProps={{ className: 'config-create-name-input', autoComplete: 'off' }}
      />

      <div className="config-create-pv-section">
        <span className="panel__form-title" aria-hidden="true">
          Parameters
        </span>
        {pvRows.map((row, index) => (
          <ParameterValueRow
            key={row.rowId}
            index={index}
            entry={row}
            onChange={updateRow}
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
        disabled={draft === null}
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
  const parameters = useStore((s) => s.document.parameters);
  const configList = Object.values(configurations);

  return (
    <aside className={classNames('panel configs-panel', className)} aria-label="Configurations">
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
            <ConfigurationRow
              key={config.name}
              config={config}
              active={isConfigurationActive(config, parameters)}
            />
          ))}
        </ul>
      )}

      <CreateConfigurationForm />
    </aside>
  );
}
