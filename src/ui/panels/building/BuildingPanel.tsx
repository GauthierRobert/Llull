/**
 * @layer ui/panels/building
 *
 * BuildingPanel — the construction (AEC/BIM) workspace, in workflow order: starter templates (empty)
 * or view actions, 1 levels, 2 element tools + the active level's elements, equipment editor,
 * 3 structural / clash checks, 4 quantities & cost, project title block, 5 deliverables.
 * Every change goes through dispatch (PRIME DIRECTIVE); exports run read-only commands.
 */

import React from 'react';
import { classNames } from '@ui/classNames';
import { useStore, useViewportStore } from '@ui/store';
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

/** Layer the AEC plugin puts cladding panels on (packages/domain-aec entities.ts). */
const CLADDING_LAYER_NAME = 'A-CLAD';

function StarterTemplates(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  return (
    <div className="building-actions" aria-label="Starter buildings">
      <span className="building-actions__label">Start from a template:</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        title="Two-storey house: levels, walls, doors, windows, slabs, roof"
        onClick={() => dispatch('add_building_template', { template: 'house' })}
      >
        Starter house
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        title="Office building: grid, columns, slabs, core"
        onClick={() => dispatch('add_building_template', { template: 'office' })}
      >
        Starter office
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        title="Steel portal-frame hall 24 × 48 m: frames, purlins, bracing, footings, cladding"
        onClick={() => dispatch('add_portal_frame_building', {})}
      >
        Steel hall
      </button>
    </div>
  );
}

/** View helpers once a building exists: frame it, and peel the cladding off to see the structure. */
function BuildingViewActions(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const claddingLayerId = useStore(
    (s) => Object.values(s.document.layers).find((layer) => layer.name === CLADDING_LAYER_NAME)?.id,
  );
  const claddingHidden = useViewportStore(
    (s) => claddingLayerId !== undefined && s.hiddenLayerIds.has(claddingLayerId),
  );
  const toggleLayerVisibility = useViewportStore((s) => s.toggleLayerVisibility);
  return (
    <div className="building-actions" aria-label="Building view">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => dispatch('fit_view', { direction: 'iso' })}
      >
        Zoom to building
      </button>
      {claddingLayerId !== undefined && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={claddingHidden}
          title="Show or hide the wall and roof cladding in the viewport (view only, the model is not changed)"
          onClick={() => toggleLayerVisibility(claddingLayerId)}
        >
          {claddingHidden ? 'Show cladding' : 'Hide cladding (see the frame)'}
        </button>
      )}
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
          hint="Start from a template below, or build it step by step: 1 levels, 2 grid and members, 3 check, 4 quantities, 5 drawings."
          compact
        />
      )}
      {elementCount > 0 ? <BuildingViewActions /> : <StarterTemplates />}
      <LevelsSection />
      <ElementToolsSection />
      <ElementListSection />
      <EquipmentSection />
      <StructuralSection />
      <ClashSection />
      <QuantitiesSection />
      <ProjectSection />
      <BuildingExportsSection />
    </div>
  );
}
