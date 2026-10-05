/**
 * @layer ui/panels/building
 *
 * EquipmentSection — every machine / equipment of the model (all levels) with an in-place editor:
 * picking a row selects it in the viewport and opens its fields; Save dispatches `update_equipment`
 * (same element id, tag and IFC GlobalId — a revision, not a delete + re-add).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { BuildingLevel, EquipmentElement } from '@core/model/building';
import { PanelSection } from '@ui/panels/PanelParts';
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

function EquipmentEditor({ element, levels }: EquipmentEditorProps): React.ReactElement {
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

export function EquipmentSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const select = useStore((s) => s.select);
  const [editingId, setEditingId] = useState<string | null>(null);
  const levels = (building?.levelOrder ?? []).flatMap((id) => {
    const level = building?.levels[id];
    return level ? [level] : [];
  });
  const equipment = (building?.elementOrder ?? []).flatMap((id) => {
    const element = building?.elements[id];
    return element?.category === 'equipment' ? [element] : [];
  });
  const editing = equipment.find((element) => element.id === editingId);
  if (equipment.length === 0) return <></>;
  return (
    <PanelSection
      title="Equipment"
      count={equipment.length}
      countLabel={`${equipment.length} equipment`}
      collapsible
      testId="building-equipment"
    >
      <ul className="panel__list" aria-label="Equipment list">
        {equipment.map((element) => (
          <li
            key={element.id}
            className={`panel__row${element.id === editingId ? ' panel__row--selected' : ''}`}
            data-testid={`equipment-row-${element.id}`}
          >
            <button
              type="button"
              className="building-row-btn"
              aria-pressed={element.id === editingId}
              aria-label={`Edit equipment ${element.mark}`}
              onClick={() => {
                select(element.entityIds);
                setEditingId(element.id === editingId ? null : element.id);
              }}
            >
              <span className="chip">{element.mark}</span>
              <span className="panel__row-main">{element.name}</span>
              <span className="panel__row-meta">
                {building?.levels[element.levelId]?.name ?? element.levelId} · {element.weight} kg
              </span>
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <EquipmentEditor key={JSON.stringify(editing)} element={editing} levels={levels} />
      )}
    </PanelSection>
  );
}
