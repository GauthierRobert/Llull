/**
 * @layer ui/panels/building
 *
 * ElementListSection — the active level's elements (plus grids): click selects the element's
 * entities in the viewport; the delete button dispatches delete_building_element.
 */

import React from 'react';
import { useStore } from '@ui/store';
import type { BuildingElement } from '@core/model/building';
import { Icon } from '@ui/components/Icon';
import { PanelSection } from '@ui/panels/PanelParts';

const CATEGORY_LABEL: Readonly<Record<BuildingElement['category'], string>> = {
  grid: 'Grid',
  wall: 'Wall',
  door: 'Door',
  window: 'Window',
  slab: 'Slab',
  column: 'Column',
  beam: 'Beam',
  stair: 'Stair',
  room: 'Room',
};

function describe(element: BuildingElement): string {
  switch (element.category) {
    case 'wall':
      return `${element.material} · ${element.thickness}`;
    case 'door':
    case 'window':
      return `${element.width}×${element.height}`;
    case 'slab':
      return `${element.role} · ${element.thickness}`;
    case 'room':
      return element.name;
    case 'column':
      return `${element.shape === 'circular' ? 'Ø' : ''}${element.width}`;
    case 'beam':
      return `${element.width}×${element.depth}`;
    case 'stair':
      return `${element.riserCount} risers`;
    case 'grid':
      return 'axis';
  }
}

interface ElementRowProps {
  element: BuildingElement;
  selected: boolean;
}

function ElementRow({ element, selected }: ElementRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const select = useStore((s) => s.select);
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
        <span className="panel__row-meta">{describe(element)}</span>
      </button>
      <span className="panel__row-actions">
        <button
          type="button"
          className="icon-btn icon-btn--danger"
          aria-label={`Delete ${CATEGORY_LABEL[element.category]} ${element.mark}`}
          onClick={() => dispatch('delete_building_element', { elementIds: [element.id] })}
        >
          <Icon name="close" size={12} />
        </button>
      </span>
    </li>
  );
}

export function ElementListSection(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const selection = useStore((s) => s.document.selection);
  const elements = building
    ? building.elementOrder.flatMap((id) => {
        const element = building.elements[id];
        if (!element) return [];
        const host = 'hostId' in element ? building.elements[element.hostId] : undefined;
        const levelId =
          'levelId' in element ? element.levelId : host && 'levelId' in host ? host.levelId : null;
        return levelId === null || levelId === building.activeLevelId ? [element] : [];
      })
    : [];
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
            selected={
              element.entityIds.length > 0 &&
              element.entityIds.every((id) => selection.includes(id))
            }
          />
        ))}
      </ul>
    </PanelSection>
  );
}
