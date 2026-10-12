/**
 * @layer ui/panels/building
 *
 * ElementListSection — the active level's elements (plus grids): click selects the element's
 * entities in the viewport; the delete button dispatches delete_building_element.
 */

import React, { memo, useMemo } from 'react';
import { useStore } from '@ui/store';
import type { BuildingElement } from '@core/model/building';
import { PanelSection, IconButton } from '@ui/panels/PanelParts';
import { CATEGORY_LABEL, describe } from './describeElement';
import { elementsOnActiveLevel, isElementSelected } from './elementListRules';

interface ElementRowProps {
  element: BuildingElement;
  selected: boolean;
}

const ElementRow = memo(function ElementRow({
  element,
  selected,
}: ElementRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const select = useStore((s) => s.select);
  const units = useStore((s) => s.document.units);
  return (
    <li
      className={`panel__row${selected ? ' panel__row--selected' : ''}`}
      data-testid={`element-row-${element.id}`}
    >
      <button
        type="button"
        className="building-row-btn"
        onClick={() => select(element.entityIds)}
        aria-label={`Select ${CATEGORY_LABEL[element.category]} ${element.mark}`}
      >
        <span className="chip">{CATEGORY_LABEL[element.category]}</span>
        <span className="panel__row-main">{element.mark}</span>
        <span className="panel__row-meta">{describe(element, units)}</span>
      </button>
      <span className="panel__row-actions">
        <IconButton
          icon="close"
          danger
          size={12}
          label={`Delete ${CATEGORY_LABEL[element.category]} ${element.mark}`}
          onClick={() => dispatch('delete_building_element', { elementIds: [element.id] })}
        />
      </span>
    </li>
  );
});

export function ElementListSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const selection = useStore((s) => s.document.selection);
  const elements = useMemo(() => elementsOnActiveLevel(building), [building]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const activeName = building?.activeLevelId
    ? building.levels[building.activeLevelId]?.name
    : undefined;
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
          <ElementRow
            key={element.id}
            element={element}
            selected={isElementSelected(element, selected)}
          />
        ))}
      </ul>
    </PanelSection>
  );
}
