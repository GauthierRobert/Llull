/**
 * @layer ui/panels/building
 * Equipment editor form: Save dispatches `update_equipment` with only the changed fields.
 * Used by the Equipment list and the Properties inspector.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel, EquipmentElement } from '@core/model/building';
import {
  EQUIPMENT_EDIT_FIELDS,
  buildEquipmentUpdate,
  equipmentValues,
  type EquipmentEditKey,
  type EquipmentEditValues,
} from './equipmentEdit';

interface EquipmentEditorProps {
  element: EquipmentElement;
  levels: ReadonlyArray<BuildingLevel>;
}

export function EquipmentEditor({ element, levels }: EquipmentEditorProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const initial = equipmentValues(element);
  const [values, setValues] = useState<EquipmentEditValues>(initial);
  const [error, setError] = useState('');

  const handleChange = (key: EquipmentEditKey, value: string): void => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setError('');
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const outcome = buildEquipmentUpdate(element.id, initial, values);
    if (!outcome.ok) {
      setError(outcome.reason);
      return;
    }
    dispatch('update_equipment', outcome.params);
  };

  return (
    <form
      className="panel__form building-form"
      onSubmit={handleSubmit}
      aria-label={`Equipment ${element.mark} properties`}
      data-testid="equipment-editor"
    >
      {EQUIPMENT_EDIT_FIELDS.map((field) => (
        <label key={field.key} className="field">
          <span className="field__label">{field.label}</span>
          <input
            type={field.kind}
            value={values[field.key]}
            onChange={(event) => handleChange(field.key, event.target.value)}
            data-testid={`equipment-edit-${field.key}`}
          />
        </label>
      ))}
      <label className="field">
        <span className="field__label">Level</span>
        <select
          value={values.levelId}
          onChange={(event) => handleChange('levelId', event.target.value)}
          data-testid="equipment-edit-levelId"
        >
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
      </label>
      {error !== '' && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn--primary btn--sm" data-testid="equipment-save">
        Save equipment
      </button>
    </form>
  );
}
