/**
 * ElementListSection — the active level's elements (plus grids): click selects the element's
 * entities in the viewport; the delete button dispatches delete_building_element.
 */

import React, { memo, useMemo } from 'react';
import { useStore } from '@ui/store';
import { useSelectionSet } from '@ui/store/selectionHooks';
import type { BuildingElement } from '@core/model/building';
import { DeleteButton, ListRow, PanelSection } from '@ui/panels/PanelParts';
import { CATEGORY_LABEL, describe } from './describeElement';
import { elementsOnActiveLevel, isElementSelected } from './elementListRules';

interface ElementRowProps {
  element: BuildingElement;
  selected: boolean;
}

const ElementRow = memo(function ElementRow({ element, selected }: ElementRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const select = useStore((s) => s.select);
  const units = useStore((s) => s.document.units);
  const typeLabel = CATEGORY_LABEL[element.category];
  return (
    <ListRow
      selected={selected}
      testId={`element-row-${element.id}`}
      label={`Select ${typeLabel} ${element.mark}`}
      onSelect={() => select(element.entityIds)}
      actions={
        <DeleteButton
          icon="close"
          size={12}
          label={`Delete ${typeLabel} ${element.mark}`}
          onDelete={() => dispatch('delete_building_element', { elementIds: [element.id] })}
        />
      }
    >
      <span className="chip">{typeLabel}</span>
      <span className="panel__row-main">{element.mark}</span>
      <span className="panel__row-meta">{describe(element, units)}</span>
    </ListRow>
  );
});

export function ElementListSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const elements = useMemo(() => elementsOnActiveLevel(building), [building]);
  const selected = useSelectionSet();
  const activeName = building?.activeLevelId ? building.levels[building.activeLevelId]?.name : undefined;
  return (
    <PanelSection
      title={activeName ? `Elements · ${activeName}` : 'Elements'}
      count={elements.length}
      countLabel={`${elements.length} elements`}
      collapsible
      testId="building-elements"
    >
      <ul className="panel__list" aria-label="Building elements">
        {elements.map((element) => (
          <ElementRow key={element.id} element={element} selected={isElementSelected(element, selected)} />
        ))}
      </ul>
    </PanelSection>
  );
}
