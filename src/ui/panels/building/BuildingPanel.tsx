/**
 * @layer ui/panels/building
 *
 * BuildingPanel — the construction (AEC/BIM) workspace: starter templates, project info,
 * levels, element tools, the active level's elements, equipment editor, clash check, quantities & cost, deliverables.
 * Every change goes through dispatch (PRIME DIRECTIVE); exports run read-only commands.
 */

import React from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { ProjectSection } from './ProjectSection';
import { LevelsSection } from './LevelsSection';
import { ElementToolsSection } from './ElementToolsSection';
import { ElementListSection } from './ElementListSection';
import { EquipmentSection } from './EquipmentSection';
import { QuantitiesSection } from './QuantitiesSection';
import { BuildingExportsSection } from './BuildingExportsSection';
import { ClashSection } from './ClashSection';
import { StructuralSection } from './StructuralSection';

function StarterTemplates(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  return (
    <div className="building-actions" aria-label="Starter buildings">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => dispatch('add_building_template', { template: 'house' })}
      >
        Starter house
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => dispatch('add_building_template', { template: 'office' })}
      >
        Starter office
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => dispatch('add_portal_frame_building', {})}
      >
        Steel hall
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => dispatch('fit_view', { direction: 'iso' })}
      >
        Zoom extents
      </button>
    </div>
  );
}

export function BuildingPanel({ className }: { className?: string }): React.ReactElement {
  const hasBuilding = useStore((s) => s.document.building !== undefined);
  const elementCount = useStore((s) => s.document.building?.elementOrder.length ?? 0);
  return (
    <div className={classNames('panel building-panel', className)} data-testid="building-panel">
      <PanelHeader
        title="Building"
        count={elementCount}
        countLabel={`${elementCount} building elements`}
      />
      {!hasBuilding && (
        <PanelEmpty
          icon="building"
          message="No building yet"
          hint="Start from a template, or add a level / grid / walls below. Walls can also be drawn with the Wall tool in the 2D view."
          compact
        />
      )}
      <StarterTemplates />
      <ProjectSection />
      <LevelsSection />
      <ElementToolsSection />
      <ElementListSection />
      <EquipmentSection />
      <ClashSection />
      <StructuralSection />
      <QuantitiesSection />
      <BuildingExportsSection />
    </div>
  );
}
