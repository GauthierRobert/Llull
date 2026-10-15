// Rename / re-paper / title block of one sheet -> `update_sheet`.

import React from 'react';
import type { DrawingSheet, PaperSize, ProjectionAngle } from '@core/model/sheet';
import { useStore } from '@ui/store';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { useFormValues } from '@ui/panels/useFormValues';
import { PAPER_OPTIONS, PROJECTION_OPTIONS, titleBlockParams } from './sheetOptions';
import { TitleBlockFields } from './TitleBlockFields';

export function EditSheetForm({ sheet }: { sheet: DrawingSheet }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const { titleBlock } = sheet;
  const form = useFormValues(() => ({
    name: sheet.name,
    paper: sheet.paper,
    projectionAngle: sheet.projectionAngle,
    title: titleBlock.title,
    drawnBy: titleBlock.drawnBy ?? '',
    partNumber: titleBlock.partNumber ?? '',
    revision: titleBlock.revision ?? '',
    date: titleBlock.date ?? '',
  }));
  const { values } = form;

  const submit = (): void => {
    if (values.name.trim() === '') return form.setError('A sheet needs a name.');
    dispatch('update_sheet', {
      sheetId: sheet.id,
      name: values.name.trim(),
      paper: values.paper as PaperSize,
      projectionAngle: values.projectionAngle as ProjectionAngle,
      ...titleBlockParams(values),
    });
  };

  return (
    <CommandForm
      ariaLabel="Edit sheet"
      submitLabel="Update sheet"
      submitTestId="sheet-update"
      error={form.error}
      ghostSubmit
      onSubmit={submit}
    >
      <LabeledInput label="Name" type="text" value={values.name} testId="sheet-edit-name" onChange={(v) => form.change('name', v)} />
      <LabeledSelect
        label="Paper"
        value={values.paper}
        options={PAPER_OPTIONS}
        testId="sheet-edit-paper"
        onChange={(v) => form.change('paper', v)}
      />
      <LabeledSelect
        label="Projection"
        value={values.projectionAngle}
        options={PROJECTION_OPTIONS}
        testId="sheet-edit-projection"
        onChange={(v) => form.change('projectionAngle', v)}
      />
      <TitleBlockFields idPrefix="sheet-edit" values={values} onChange={(key, value) => form.change(key, value)} />
    </CommandForm>
  );
}
