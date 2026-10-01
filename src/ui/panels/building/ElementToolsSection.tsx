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
import {
  ELEMENT_TOOLS,
  defaultValues,
  type ElementListKind,
  type ElementTool,
  type ToolField,
} from './elementTools';
import { INDUSTRIAL_TOOLS } from './industrialTools';

const ALL_TOOLS: ReadonlyArray<ElementTool> = [...ELEMENT_TOOLS, ...INDUSTRIAL_TOOLS];
const TOOL_GROUPS: ReadonlyArray<string> = [
  ...new Set(ALL_TOOLS.map((tool) => tool.group ?? 'Building')),
];

interface ElementOption {
  readonly id: string;
  readonly label: string;
}

type ElementOptions = Readonly<Record<ElementListKind, ReadonlyArray<ElementOption>>>;

const NO_OPTIONS: ElementOptions = { walls: [], hosts: [], stairs: [], slabs: [] };

/** Active level's walls and stairs, and every slab (stair wells cut the slab above). */
function elementOptions(building: BuildingModel | undefined): ElementOptions {
  if (!building) return NO_OPTIONS;
  const options: Record<ElementListKind, ElementOption[]> = {
    walls: [],
    hosts: [],
    stairs: [],
    slabs: [],
  };
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (!element) continue;
    const onActiveLevel = 'levelId' in element && element.levelId === building.activeLevelId;
    if (element.category === 'wall' && onActiveLevel) {
      const length = Math.hypot(
        element.end[0] - element.start[0],
        element.end[1] - element.start[1],
      );
      options.walls.push({ id, label: `${element.mark} · ${Math.round(length)} long` });
      options.hosts.push({ id, label: `${element.mark} · ${Math.round(length)} long` });
    } else if (element.category === 'curvedWall' && onActiveLevel) {
      options.hosts.push({ id, label: `${element.mark} · curved` });
    } else if (element.category === 'stair' && onActiveLevel) {
      options.stairs.push({ id, label: `${element.mark} · ${element.riserCount} risers` });
    } else if (element.category === 'slab') {
      const level = building.levels[element.levelId]?.name ?? element.levelId;
      options.slabs.push({ id, label: `${element.mark} · ${element.role} · ${level}` });
    }
  }
  return options;
}

interface FieldInputProps {
  field: ToolField;
  value: string;
  lists: ElementOptions;
  onChange: (key: string, value: string) => void;
}

function FieldInput({ field, value, lists, onChange }: FieldInputProps): React.ReactElement {
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
    const live = typeof field.options === 'string' ? lists[field.options] : null;
    const options = live
      ? live.map((option): readonly [string, string] => [option.id, option.label])
      : typeof field.options === 'string'
        ? []
        : (field.options ?? []);
    return (
      <label className="field">
        <span className="field__label">{field.label}</span>
        <select
          value={value}
          onChange={(event) => onChange(field.key, event.target.value)}
          data-testid={testId}
        >
          {live && <option value="">{live.length === 0 ? 'None available' : 'Choose…'}</option>}
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
  const lists = useMemo(() => elementOptions(building), [building]);

  const handleChange = (key: string, value: string): void => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setError('');
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const outcome = tool.build(values, {
      levelId: building?.activeLevelId ?? null,
      wallIds: lists.walls.map((wall) => wall.id),
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
          lists={lists}
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
  const [toolId, setToolId] = useState<string>(ALL_TOOLS[0]?.id ?? '');
  const lastSummary = useStore((s) => s.lastSummary);
  const tool = ALL_TOOLS.find((candidate) => candidate.id === toolId) ?? ALL_TOOLS[0];
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
          {TOOL_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {ALL_TOOLS.filter((candidate) => (candidate.group ?? 'Building') === group).map(
                (candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ),
              )}
            </optgroup>
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
