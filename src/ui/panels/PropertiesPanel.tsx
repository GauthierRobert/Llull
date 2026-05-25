/**
 * @layer ui/panels
 *
 * PropertiesPanel — a left-docked panel with two sections:
 *
 * 1. Selection  — shows properties of the currently selected entity (read-only v1).
 *                 For 0 or multiple selections, shows a summary count.
 *
 * 2. Run Command — a <select> over all registered commands; when one is chosen
 *                  its paramsSchema drives <ParamForm>; on submit the panel calls
 *                  `dispatch(cmd.name, gatheredParams)`.
 *
 * PRIME DIRECTIVE: this panel NEVER builds an Entity or mutates the document.
 * It only gathers params and calls dispatch. (architecture L1, react R1)
 */

import React, { useState, useCallback } from 'react';
import { listCommands } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { ParamForm } from './ParamForm';
import type { Entity } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLabel(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatVec(v: readonly number[]): string {
  return v.map((n) => n.toFixed(3)).join(', ');
}

// ---------------------------------------------------------------------------
// Selection section
// ---------------------------------------------------------------------------

interface SelectionSectionProps {
  selection: readonly string[];
  entities: Record<string, Entity>;
}

function SelectionSection({ selection, entities }: SelectionSectionProps): React.ReactElement {
  if (selection.length === 0) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">No entity selected.</p>
      </section>
    );
  }

  if (selection.length > 1) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">{selection.length} entities selected.</p>
      </section>
    );
  }

  const id = selection[0];
  if (!id) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">No entity selected.</p>
      </section>
    );
  }

  const entity = entities[id];
  if (!entity) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">Entity not found.</p>
      </section>
    );
  }

  return (
    <section className="props-section" aria-label="Selection">
      <h2 className="props-section-title">Selection</h2>
      <dl className="props-list">
        <div className="props-row">
          <dt className="props-key">Kind</dt>
          <dd className="props-value">{entity.kind}</dd>
        </div>
        <div className="props-row">
          <dt className="props-key">ID</dt>
          <dd className="props-value props-id">{entity.id}</dd>
        </div>
        <div className="props-row">
          <dt className="props-key">Position</dt>
          <dd className="props-value">{formatVec(entity.position)}</dd>
        </div>
        <div className="props-row">
          <dt className="props-key">Color</dt>
          <dd className="props-value">
            <span
              className="props-color-swatch"
              style={{ background: entity.color }}
              aria-label={entity.color}
            />
            {entity.color}
          </dd>
        </div>
        <EntityDimensions entity={entity} />
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Kind-specific dimension rows
// ---------------------------------------------------------------------------

function EntityDimensions({ entity }: { entity: Entity }): React.ReactElement | null {
  switch (entity.kind) {
    case 'box':
      return (
        <div className="props-row">
          <dt className="props-key">Size</dt>
          <dd className="props-value">{formatVec(entity.size)}</dd>
        </div>
      );
    case 'cylinder':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Radius</dt>
            <dd className="props-value">{entity.radius.toFixed(3)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">Height</dt>
            <dd className="props-value">{entity.height.toFixed(3)}</dd>
          </div>
        </>
      );
    case 'sphere':
      return (
        <div className="props-row">
          <dt className="props-key">Radius</dt>
          <dd className="props-value">{entity.radius.toFixed(3)}</dd>
        </div>
      );
    case 'extrusion':
      return (
        <div className="props-row">
          <dt className="props-key">Depth</dt>
          <dd className="props-value">{entity.depth.toFixed(3)}</dd>
        </div>
      );
    case 'circle':
      return (
        <div className="props-row">
          <dt className="props-key">Radius</dt>
          <dd className="props-value">{entity.radius.toFixed(3)}</dd>
        </div>
      );
    case 'arc':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Radius</dt>
            <dd className="props-value">{entity.radius.toFixed(3)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">Start Angle</dt>
            <dd className="props-value">{entity.startAngle.toFixed(3)} rad</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">End Angle</dt>
            <dd className="props-value">{entity.endAngle.toFixed(3)} rad</dd>
          </div>
        </>
      );
    case 'rectangle':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Width</dt>
            <dd className="props-value">{entity.width.toFixed(3)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">Height</dt>
            <dd className="props-value">{entity.height.toFixed(3)}</dd>
          </div>
        </>
      );
    case 'line':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Start</dt>
            <dd className="props-value">{formatVec(entity.start)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">End</dt>
            <dd className="props-value">{formatVec(entity.end)}</dd>
          </div>
        </>
      );
    case 'polyline':
      return (
        <div className="props-row">
          <dt className="props-key">Points</dt>
          <dd className="props-value">{entity.points.length} pts</dd>
        </div>
      );
    case 'point':
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Run-command section
// ---------------------------------------------------------------------------

interface RunCommandSectionProps {
  onDispatch: (name: string, params: Record<string, unknown>) => void;
}

function RunCommandSection({ onDispatch }: RunCommandSectionProps): React.ReactElement {
  const commands = listCommands();
  const [selectedName, setSelectedName] = useState<string>(commands[0]?.name ?? '');

  const selectedCmd = commands.find((c) => c.name === selectedName);

  const handleSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedName(e.target.value);
  }, []);

  const handleSubmit = useCallback(
    (params: Record<string, unknown>) => {
      if (selectedCmd) {
        onDispatch(selectedCmd.name, params);
      }
    },
    [selectedCmd, onDispatch],
  );

  return (
    <section className="props-section" aria-label="Run command">
      <h2 className="props-section-title">Run Command</h2>

      <div className="param-field">
        <label htmlFor="props-command-select" className="param-label">
          Command
        </label>
        <select
          id="props-command-select"
          className="param-select"
          value={selectedName}
          onChange={handleSelect}
        >
          {commands.map((cmd) => (
            <option key={cmd.name} value={cmd.name}>
              {toLabel(cmd.name)}
            </option>
          ))}
        </select>
      </div>

      {selectedCmd && (
        <p className="props-cmd-description">{selectedCmd.description}</p>
      )}

      {selectedCmd && Object.keys(selectedCmd.paramsSchema.properties).length > 0 ? (
        <ParamForm
          key={selectedCmd.name}
          schema={selectedCmd.paramsSchema}
          onSubmit={handleSubmit}
          submitLabel={`Run ${toLabel(selectedCmd.name)}`}
        />
      ) : selectedCmd ? (
        <button
          type="button"
          className="param-submit"
          onClick={() => onDispatch(selectedCmd.name, {})}
        >
          {`Run ${toLabel(selectedCmd.name)}`}
        </button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PropertiesPanel
// ---------------------------------------------------------------------------

export interface PropertiesPanelProps {
  className?: string;
}

export function PropertiesPanel({ className }: PropertiesPanelProps): React.ReactElement {
  const selection = useStore((s) => s.document.selection);
  const entities = useStore((s) => s.document.entities);
  const dispatch = useStore((s) => s.dispatch);

  const handleDispatch = useCallback(
    (name: string, params: Record<string, unknown>) => {
      dispatch(name, params);
    },
    [dispatch],
  );

  return (
    <aside
      className={['app-properties', className].filter(Boolean).join(' ')}
      aria-label="Properties"
    >
      <SelectionSection selection={selection} entities={entities} />
      <div className="props-divider" />
      <RunCommandSection onDispatch={handleDispatch} />
    </aside>
  );
}
