/**
 * @layer ui/panels/building
 *
 * ElementToolsSection — pick a building tool (grid, walls, doors, windows, slabs…), fill its
 * parameters, dispatch the single command it maps to (see elementTools.ts).
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@ui/store';
import type { BuildingModel } from '@core/model/building';
import { PanelSection } from '@ui/panels/PanelParts';
import { ELEMENT_TOOLS, defaultValues, type ElementTool, type ToolField } from './elementTools';

interface WallOption {
  readonly id: string;
  readonly label: string;
}

function wallsOnLevel(building: BuildingModel | undefined): WallOption[] {
  if (!building) return [];
  return building.elementOrder.flatMap((id) => {
    const element = building.elements[id];
    if (element?.category !== 'wall' || element.levelId !== building.activeLevelId) return [];
    const length = Math.hypot(element.end[0] - element.start[0], element.end[1] - element.start[1]);
    return [{ id, label: `${element.mark} · ${Math.round(length)} long` }];
  });
}

interface FieldInputProps {
  field: ToolField;
  value: string;
  walls: ReadonlyArray<WallOption>;
  onChange: (key: string, value: string) => void;
}

function FieldInput({ field, value, walls, onChange }: FieldInputProps): React.ReactElement {
  const testId = `tool-field-${field.key}`;
  if (field.kind === 'checkbox') {
    return (
      <label className="field">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(event) => onChange(field.key, String(event.target.checked))}
          data-testid={testId}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.kind === 'select') {
    const options =
      field.options === 'walls'
        ? walls.map((wall): readonly [string, string] => [wall.id, wall.label])
        : (field.options ?? []);
    return (
      <label className="field">
        <span className="field__label">{field.label}</span>
        <select
          value={value}
          onChange={(event) => onChange(field.key, event.target.value)}
          data-testid={testId}
        >
          {field.options === 'walls' && (
            <option value="">{walls.length === 0 ? 'No walls on level' : 'Choose…'}</option>
          )}
          {options.map(([optionValue, label]) => (
            <option key={optionValue} value={optionValue}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="field">
      <span className="field__label">{field.label}</span>
      <input
        type={field.kind === 'number' ? 'number' : 'text'}
        value={value}
        placeholder={field.optional === true ? 'auto' : undefined}
        onChange={(event) => onChange(field.key, event.target.value)}
        data-testid={testId}
      />
    </label>
  );
}

interface ToolFormProps {
  tool: ElementTool;
}

function ToolForm({ tool }: ToolFormProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const building = useStore((s) => s.document.building);
  const [values, setValues] = useState<Record<string, string>>(() => defaultValues(tool));
  const [error, setError] = useState('');
  const walls = useMemo(() => wallsOnLevel(building), [building]);

  const handleChange = (key: string, value: string): void => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setError('');
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const outcome = tool.build(values, {
      levelId: building?.activeLevelId ?? null,
      wallIds: walls.map((wall) => wall.id),
    });
    if (!outcome.ok) {
      setError(outcome.reason);
      return;
    }
    dispatch(outcome.command, outcome.params);
  };

  return (
    <form
      className="panel__form building-form"
      onSubmit={handleSubmit}
      aria-label={`Add ${tool.label}`}
    >
      {tool.fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          walls={walls}
          onChange={handleChange}
        />
      ))}
      {error !== '' && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn--primary btn--sm" data-testid="tool-submit">
        Add {tool.label.toLowerCase()}
      </button>
    </form>
  );
}

export function ElementToolsSection(): React.ReactElement {
  const [toolId, setToolId] = useState<string>(ELEMENT_TOOLS[0]?.id ?? '');
  const lastSummary = useStore((s) => s.lastSummary);
  const tool = ELEMENT_TOOLS.find((candidate) => candidate.id === toolId) ?? ELEMENT_TOOLS[0];
  return (
    <PanelSection title="Add element" testId="building-tools">
      <label className="field building-tool-picker">
        <span className="field__label">Tool</span>
        <select
          value={toolId}
          onChange={(event) => setToolId(event.target.value)}
          aria-label="Building tool"
          data-testid="building-tool-select"
        >
          {ELEMENT_TOOLS.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      {tool && <ToolForm key={tool.id} tool={tool} />}
      {lastSummary !== null && lastSummary !== '' && (
        <p className="building-summary" role="status" data-testid="building-last-summary">
          {lastSummary}
        </p>
      )}
    </PanelSection>
  );
}
