/**
 * Equipment editor form: Save dispatches `update_equipment` with only the changed fields.
 * Used by the Equipment list and the Properties inspector.
 */

import React from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel, EquipmentElement } from '@core/model/building';
import { CommandForm } from '@ui/panels/CommandForm';
import { useFormValues } from '@ui/panels/useFormValues';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { LevelSelect } from './LevelSelect';
import { EQUIPMENT_EDIT_FIELDS, buildEquipmentUpdate, equipmentValues, type EquipmentEditValues } from './equipmentEdit';
import { EQUIPMENT_SHAPE_OPTIONS } from './industrialTools';

interface EquipmentEditorProps {
  element: EquipmentElement;
  levels: ReadonlyArray<BuildingLevel>;
}

export function EquipmentEditor({ element, levels }: EquipmentEditorProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const initial = equipmentValues(element);
  const { values, error, setError, change } = useFormValues<EquipmentEditValues>(() => initial);

  const handleSubmit = (): void => {
    const outcome = buildEquipmentUpdate(element.id, initial, values);
    if (!outcome.ok) {
      setError(outcome.reason);
      return;
    }
    dispatch('update_equipment', outcome.params);
  };

  return (
    <CommandForm
      ariaLabel={`Equipment ${element.mark} properties`}
      error={error}
      submitLabel="Save equipment"
      submitTestId="equipment-save"
      testId="equipment-editor"
      onSubmit={handleSubmit}
    >
      {EQUIPMENT_EDIT_FIELDS.map((field) => (
        <LabeledInput
          key={field.key}
          label={field.label}
          type={field.kind}
          value={values[field.key]}
          onChange={(value) => change(field.key, value)}
          testId={`equipment-edit-${field.key}`}
        />
      ))}
      <LabeledSelect
        label="Shape"
        value={values.shape}
        options={EQUIPMENT_SHAPE_OPTIONS}
        testId="equipment-edit-shape"
        onChange={(value) => change('shape', value)}
      />
      <LevelSelect
        showLabel
        label="Level"
        levels={levels}
        value={values.levelId}
        testId="equipment-edit-levelId"
        onChange={(levelId) => change('levelId', levelId)}
      />
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        data-testid="equipment-cut-openings"
        title="Cut an opening (footprint + 300 mm) in every floor this equipment passes through"
        onClick={() => dispatch('add_equipment_openings', { equipmentId: element.id })}
      >
        Cut floor openings
      </button>
    </CommandForm>
  );
}
