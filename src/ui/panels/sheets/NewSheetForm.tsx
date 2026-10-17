// "New sheet": name, paper, projection angle, title block and standard views -> `create_sheet`.

import React, { useState } from 'react';
import type { PaperSize, ProjectionAngle, ViewDirection } from '@core/model/sheet';
import { useStore } from '@ui/store';
import { toggledInList } from '@ui/toggleMember';
import { optionalText } from '@ui/numberText';
import { CheckboxGroup } from '@ui/panels/CheckboxGroup';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { useFormValues } from '@ui/panels/useFormValues';
import { DEFAULT_STANDARD_VIEWS, EMPTY_TITLE_BLOCK, STANDARD_VIEW_OPTIONS, titleBlockParams } from './sheetOptions';
import { PaperFields } from './PaperFields';
import { TitleBlockFields } from './TitleBlockFields';

const INITIAL = { name: '', paper: 'A3', projectionAngle: 'first', ...EMPTY_TITLE_BLOCK };

export function NewSheetForm({ onSubmitted }: { onSubmitted: () => void }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const form = useFormValues(() => INITIAL);
  const [views, setViews] = useState<readonly ViewDirection[]>(DEFAULT_STANDARD_VIEWS);
  const { values } = form;

  const submit = (): void => {
    dispatch('create_sheet', {
      ...optionalText('name', values.name),
      paper: values.paper as PaperSize,
      projectionAngle: values.projectionAngle as ProjectionAngle,
      ...titleBlockParams(values),
      views,
    });
    onSubmitted();
  };

  return (
    <CommandForm ariaLabel="New sheet" submitLabel="Create sheet" submitTestId="sheet-create" onSubmit={submit}>
      <LabeledInput label="Name" type="text" placeholder="Sheet 1" testId="sheet-new-name" {...inputOf(form.field('name'))} />
      <PaperFields
        idPrefix="sheet-new"
        paper={values.paper}
        projectionAngle={values.projectionAngle}
        onChange={(key, value) => form.change(key, value)}
      />
      <TitleBlockFields idPrefix="sheet-new" values={values} onChange={(key, value) => form.change(key, value)} />
      <CheckboxGroup
        legend="Views"
        options={STANDARD_VIEW_OPTIONS}
        selected={views}
        onToggle={(value) => setViews((current) => toggledInList(current, value as ViewDirection))}
      />
    </CommandForm>
  );
}

function inputOf(field: { value: string; set: (value: string) => void }): { value: string; onChange: (value: string) => void } {
  return { value: field.value, onChange: field.set };
}
