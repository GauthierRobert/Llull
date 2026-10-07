/**
 * @layer ui/panels/building
 *
 * EquipmentSection — every machine / equipment of the model (all levels) with an in-place editor:
 * picking a row selects it in the viewport and opens its fields; Save dispatches `update_equipment`
 * (same element id, tag and IFC GlobalId — a revision, not a delete + re-add).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { orderedValues } from '@ui/panels/orderedValues';
import { EquipmentEditor } from './EquipmentEditor';

export function EquipmentSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const select = useStore((s) => s.select);
  const [editingId, setEditingId] = useState<string | null>(null);
  const levels = building ? orderedValues(building.levelOrder, building.levels) : [];
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
