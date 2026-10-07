/**
 * @layer ui/panels/building
 * Equipment editor form: Save dispatches `update_equipment` with only the changed fields.
 * Used by the Equipment list and the Properties inspector.
 */

import React from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel, EquipmentElement } from '@core/model/building';
import { BuildingForm } from './BuildingForm';
import { useFormValues } from './useFormValues';
import {
  EQUIPMENT_EDIT_FIELDS,
  buildEquipmentUpdate,
  equipmentValues,
  type EquipmentEditValues,
} from './equipmentEdit';

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
    <BuildingForm
      ariaLabel={`Equipment ${element.mark} properties`}
      error={error}
      submitLabel="Save equipment"
      submitTestId="equipment-save"
      testId="equipment-editor"
      onSubmit={handleSubmit}
    >
      {EQUIPMENT_EDIT_FIELDS.map((field) => (
        <label key={field.key} className="field">
          <span className="field__label">{field.label}</span>
          <input
            type={field.kind}
            value={values[field.key]}
            onChange={(event) => change(field.key, event.target.value)}
            data-testid={`equipment-edit-${field.key}`}
          />
        </label>
      ))}
      <label className="field">
        <span className="field__label">Level</span>
        <select
          value={values.levelId}
          onChange={(event) => change('levelId', event.target.value)}
          data-testid="equipment-edit-levelId"
        >
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
      </label>
    </BuildingForm>
  );
}
