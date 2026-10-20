// "Add datum feature": solid, optional letter and a world point on the face -> `add_datum_feature` (the face is re-found from the point at
// every replay, so the form gathers a point, never a face index).

import React from 'react';
import { is3D } from '@core/model/types';
import { useStore } from '@ui/store';
import { optionalText, parseNumber } from '@ui/numberText';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { useFormValues } from '@ui/panels/useFormValues';

const INITIAL = { entityId: '', label: '', x: '', y: '', z: '' };

export function AddDatumForm(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const order = useStore((s) => s.document.order);
  const entities = useStore((s) => s.document.entities);
  const solids = order.filter((id) => {
    const entity = entities[id];
    return entity !== undefined && is3D(entity);
  });
  const form = useFormValues(() => INITIAL);
  const { values } = form;

  const submit = (): void => {
    const point = [parseNumber(values.x), parseNumber(values.y), parseNumber(values.z)];
    const entityId = values.entityId === '' ? solids[0] : values.entityId;
    if (entityId === undefined) return form.setError('Add a 3D solid first.');
    if (!point.every((c): c is number => c !== undefined)) return form.setError('Give the x, y and z of a point on the face.');
    dispatch('add_datum_feature', { entityId, facesNear: [point], ...optionalText('label', values.label) });
  };

  return (
    <CommandForm ariaLabel="Add datum feature" submitLabel="Add datum" submitTestId="pmi-datum-add" error={form.error} onSubmit={submit}>
      <LabeledSelect
        label="Solid"
        value={values.entityId}
        options={solids.map((id): readonly [string, string] => [id, id])}
        testId="pmi-datum-entity"
        onChange={(value) => form.change('entityId', value)}
      />
      <LabeledInput label="Letter" type="text" placeholder="next free" testId="pmi-datum-label" {...bind(form.field('label'))} />
      <LabeledInput label="Face point x" type="number" testId="pmi-datum-x" {...bind(form.field('x'))} />
      <LabeledInput label="Face point y" type="number" testId="pmi-datum-y" {...bind(form.field('y'))} />
      <LabeledInput label="Face point z" type="number" testId="pmi-datum-z" {...bind(form.field('z'))} />
    </CommandForm>
  );
}

function bind(field: { value: string; set: (value: string) => void }): { value: string; onChange: (value: string) => void } {
  return { value: field.value, onChange: field.set };
}
