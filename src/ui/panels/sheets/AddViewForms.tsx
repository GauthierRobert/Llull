// Add a projection, section or detail view to a sheet: `create_drawing_view`, `add_section_view`, `add_detail_view`.

import React from 'react';
import type { DrawingSheet, ViewDirection } from '@core/model/sheet';
import { useStore } from '@ui/store';
import { parseNumber, optionalNumber } from '@ui/numberText';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { useFormValues } from '@ui/panels/useFormValues';
import { DIRECTION_OPTIONS, SECTION_DIRECTION_OPTIONS } from './sheetOptions';

/** Views a section / detail can be drawn from (a detail cannot parent anything). */
function parentOptions(sheet: DrawingSheet): Array<readonly [string, string]> {
  return sheet.views.filter((view) => view.kind !== 'detail').map((view) => [view.id, view.label]);
}

function ProjectionViewForm({ sheet }: { sheet: DrawingSheet }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const form = useFormValues(() => ({ direction: 'front' }));
  return (
    <CommandForm
      ariaLabel="Add view"
      submitLabel="Add view"
      submitTestId="sheet-add-view"
      ghostSubmit
      onSubmit={() => dispatch('create_drawing_view', { sheetId: sheet.id, direction: form.values.direction as ViewDirection })}
    >
      <LabeledSelect
        label="Direction"
        value={form.values.direction}
        options={DIRECTION_OPTIONS}
        testId="sheet-view-direction"
        onChange={(v) => form.change('direction', v)}
      />
    </CommandForm>
  );
}

function SectionViewForm({ sheet }: { sheet: DrawingSheet }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const form = useFormValues(() => ({ direction: 'right', offset: '0', parentViewId: '' }));
  const { values } = form;
  const submit = (): void => {
    const offset = parseNumber(values.offset);
    if (offset === undefined) return form.setError('Offset must be a number.');
    dispatch('add_section_view', {
      sheetId: sheet.id,
      direction: values.direction as Exclude<ViewDirection, 'iso'>,
      offset,
      ...(values.parentViewId === '' ? {} : { parentViewId: values.parentViewId }),
    });
  };
  return (
    <CommandForm
      ariaLabel="Add section view"
      submitLabel="Add section"
      submitTestId="sheet-add-section"
      error={form.error}
      ghostSubmit
      onSubmit={submit}
    >
      <LabeledSelect
        label="Direction"
        value={values.direction}
        options={SECTION_DIRECTION_OPTIONS}
        testId="sheet-section-direction"
        onChange={(v) => form.change('direction', v)}
      />
      <LabeledInput
        label="Offset"
        type="text"
        value={values.offset}
        title="World coordinate of the cutting plane on the viewing axis"
        testId="sheet-section-offset"
        onChange={(v) => form.change('offset', v)}
      />
      <LabeledSelect
        label="Parent"
        value={values.parentViewId}
        options={parentOptions(sheet)}
        blankLabel="None (no cutting line)"
        testId="sheet-section-parent"
        onChange={(v) => form.change('parentViewId', v)}
      />
    </CommandForm>
  );
}

function DetailViewForm({ sheet }: { sheet: DrawingSheet }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const parents = parentOptions(sheet);
  const form = useFormValues(() => ({ parentViewId: '', x: '0', y: '0', radius: '10', scale: '' }));
  const { values } = form;
  const parentViewId = values.parentViewId === '' ? (parents[0]?.[0] ?? '') : values.parentViewId;
  const submit = (): void => {
    const x = parseNumber(values.x);
    const y = parseNumber(values.y);
    const radius = parseNumber(values.radius);
    if (parentViewId === '') return form.setError('Add a projection or section view first.');
    if (x === undefined || y === undefined) return form.setError('Center must be two numbers.');
    if (radius === undefined || radius <= 0) return form.setError('Radius must be a positive number.');
    dispatch('add_detail_view', { sheetId: sheet.id, parentViewId, center: [x, y], radius, ...optionalNumber('scale', values.scale) });
  };
  return (
    <CommandForm
      ariaLabel="Add detail view"
      submitLabel="Add detail"
      submitTestId="sheet-add-detail"
      error={form.error}
      ghostSubmit
      onSubmit={submit}
    >
      <LabeledSelect
        label="Parent"
        value={parentViewId}
        options={parents}
        testId="sheet-detail-parent"
        onChange={(v) => form.change('parentViewId', v)}
      />
      <LabeledInput label="Center X" type="text" value={values.x} testId="sheet-detail-x" onChange={(v) => form.change('x', v)} />
      <LabeledInput label="Center Y" type="text" value={values.y} testId="sheet-detail-y" onChange={(v) => form.change('y', v)} />
      <LabeledInput
        label="Radius"
        type="text"
        value={values.radius}
        testId="sheet-detail-radius"
        onChange={(v) => form.change('radius', v)}
      />
      <LabeledInput
        label="Scale 1:N"
        type="text"
        value={values.scale}
        placeholder="2x the sheet"
        testId="sheet-detail-scale"
        onChange={(v) => form.change('scale', v)}
      />
    </CommandForm>
  );
}

export const AddViewForms = { Projection: ProjectionViewForm, Section: SectionViewForm, Detail: DetailViewForm };
