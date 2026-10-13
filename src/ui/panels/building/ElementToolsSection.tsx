/**
 * @layer ui/panels/building
 *
 * ElementToolsSection — pick a building tool (grid, walls, doors, windows, slabs…), fill its
 * parameters, dispatch the single command it maps to (see elementTools.ts).
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { ELEMENT_TOOLS } from './elementTools';
import { defaultValues, isFieldShown, type ElementListKind, type ElementTool, type ToolField } from './elementToolForm';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { StatusLine } from '@ui/panels/PanelParts';
import { useFormValues } from '@ui/panels/useFormValues';
import { INDUSTRIAL_TOOLS } from './industrialTools';
import { gridExtent } from './gridExtent';
import { elementOptions, type ElementOptions } from './elementOptions';

const ALL_TOOLS: ReadonlyArray<ElementTool> = [...ELEMENT_TOOLS, ...INDUSTRIAL_TOOLS];
const TOOL_GROUPS: ReadonlyArray<string> = [...new Set(ALL_TOOLS.map((tool) => tool.group ?? 'Building'))];

/** Label of the blank first option of a live list. */
function blankOptionLabel(listKind: ElementListKind, listLength: number): string {
  if (listKind === 'levels') return 'Active level';
  return listLength === 0 ? 'None available' : 'Choose…';
}

interface FieldInputProps {
  field: ToolField;
  value: string;
  lists: ElementOptions;
  units: string;
  onChange: (key: string, value: string) => void;
}

function FieldInput({ field, value, lists, units, onChange }: FieldInputProps): React.ReactElement {
  const fieldLabel = field.label.replace('{unit}', units);
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
        <span>{fieldLabel}</span>
      </label>
    );
  }
  if (field.kind === 'select') {
    const listKind = typeof field.options === 'string' ? field.options : null;
    const options: ReadonlyArray<readonly [string, string]> =
      typeof field.options === 'string'
        ? lists[field.options].map((option): readonly [string, string] => [option.id, option.label])
        : (field.options ?? []);
    return (
      <LabeledSelect
        label={fieldLabel}
        value={value}
        options={options}
        {...(listKind !== null ? { blankLabel: field.blankLabel ?? blankOptionLabel(listKind, lists[listKind].length) } : {})}
        testId={testId}
        onChange={(chosen) => onChange(field.key, chosen)}
      />
    );
  }
  return (
    <LabeledInput
      label={fieldLabel}
      type={field.kind === 'number' ? 'number' : 'text'}
      value={value}
      placeholder={field.optional === true ? 'auto' : undefined}
      testId={testId}
      onChange={(text) => onChange(field.key, text)}
    />
  );
}

interface ToolFormProps {
  tool: ElementTool;
}

function ToolForm({ tool }: ToolFormProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const { values, error, setError, change } = useFormValues(() => defaultValues(tool));
  const lists = useMemo(() => elementOptions(building), [building]);

  const handleSubmit = (): void => {
    const outcome = tool.build(values, {
      levelId: building?.activeLevelId ?? null,
      wallIds: lists.walls.map((wall) => wall.id),
      gridExtent: gridExtent(building),
    });
    if (!outcome.ok) {
      setError(outcome.reason);
      return;
    }
    dispatch(outcome.command, outcome.params);
  };

  return (
    <CommandForm
      ariaLabel={`Add ${tool.label}`}
      error={error}
      submitLabel={`Add ${tool.label.toLowerCase()}`}
      submitTestId="tool-submit"
      onSubmit={handleSubmit}
    >
      {tool.fields
        .filter((field) => isFieldShown(field, values))
        .map((field) => (
          <FieldInput key={field.key} field={field} value={values[field.key] ?? ''} lists={lists} units={units} onChange={change} />
        ))}
    </CommandForm>
  );
}

export function ElementToolsSection(): React.ReactElement {
  const [toolId, setToolId] = useState<string>(ALL_TOOLS[0]?.id ?? '');
  const lastSummary = useStore((s) => s.lastSummary);
  const tool = ALL_TOOLS.find((candidate) => candidate.id === toolId) ?? ALL_TOOLS[0];
  return (
    <PanelSection
      title="Add element"
      step={2}
      hint="Usual order: structural grid → columns → beams → bracing → slabs and walls. Pick what to add, check the values, then press the blue button."
      testId="building-tools"
    >
      <label className="field building-tool-picker">
        <span className="field__label">What to add</span>
        <select
          value={toolId}
          onChange={(event) => setToolId(event.target.value)}
          aria-label="Building tool"
          data-testid="building-tool-select"
        >
          {TOOL_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {ALL_TOOLS.filter((candidate) => (candidate.group ?? 'Building') === group).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {tool && <ToolForm key={tool.id} tool={tool} />}
      <StatusLine text={lastSummary ?? ''} testId="building-last-summary" />
    </PanelSection>
  );
}
