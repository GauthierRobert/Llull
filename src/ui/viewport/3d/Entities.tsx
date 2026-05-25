/**
 * @layer ui/viewport/3d
 *
 * Maps `document.order` → a render branch per entity `kind`.
 * Every kind has exactly one branch (OCP / architecture L7).
 * Hidden layers are not rendered; selection state is passed to each branch.
 * Hidden-entity override (render-only, UI store) is also respected here.
 *
 * Click wiring: plain click → select([id]); Shift/Ctrl/Meta click → toggleSelection(id).
 * The `onSelect` callback is threaded from the store down to each mesh via EntityRenderer.
 */

import { useCallback } from 'react';
import type { CadDocument, Entity, EntityId } from '@core/model/types';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import { findClickAnimationsForEntity } from './animationClickHelpers';
import { BoxMesh } from './entities/BoxMesh';
import { CylinderMesh } from './entities/CylinderMesh';
import { SphereMesh } from './entities/SphereMesh';
import { ExtrusionMesh } from './entities/ExtrusionMesh';
import { MeshSolidMesh } from './entities/MeshSolidMesh';
import { ConeMesh } from './entities/ConeMesh';
import { TorusMesh } from './entities/TorusMesh';
import { WedgeMesh } from './entities/WedgeMesh';
import { PyramidMesh } from './entities/PyramidMesh';

interface EntitiesProps {
  document: CadDocument;
}

/** Render a single entity; one pure branch per `kind`. */
function EntityRenderer({
  entity,
  selected,
  onSelect,
}: {
  entity: Entity;
  selected: boolean;
  onSelect: (id: EntityId, additive: boolean) => void;
}): React.ReactElement | null {
  switch (entity.kind) {
    case 'box':
      return <BoxMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'cylinder':
      return <CylinderMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'sphere':
      return <SphereMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'extrusion':
      return <ExtrusionMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'mesh':
      return <MeshSolidMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'cone':
      return <ConeMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'torus':
      return <TorusMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'wedge':
      return <WedgeMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'pyramid':
      return <PyramidMesh entity={entity} selected={selected} onSelect={onSelect} />;
    default:
      // 2D shape kinds (line/arc/circle/…) are drawn by the 2D viewport (Lane 3 / D1),
      // not in the 3D scene. Keeping a tolerant default lets the Entity union grow
      // without breaking this branch (architecture L7).
      return null;
  }
}

export function Entities({ document }: EntitiesProps): React.ReactElement {
  const { order, entities, layers, selection } = document;
  const selectionSet = new Set<EntityId>(selection);

  const select = useStore((s) => s.select);
  const toggleSelection = useStore((s) => s.toggleSelection);

  // Render-only visibility overrides — never touch the document (PRIME DIRECTIVE).
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const toggleClickAnimation = useViewportStore((s) => s.toggleClickAnimation);

  /**
   * Called by each mesh on click.
   * Plain click → single-select; Shift/Ctrl/Meta click → toggle (multi-select).
   * Also toggles any `trigger:'click'` animations that target this entity (directly
   * or via a group whose memberIds include it) — without removing select behaviour.
   */
  const handleSelect = useCallback(
    (id: EntityId, additive: boolean): void => {
      // 1. Normal selection behaviour.
      if (additive) {
        toggleSelection(id);
      } else {
        select([id]);
      }

      // 2. Toggle any click-triggered animations for this entity.
      const animations = useStore.getState().document.animations;
      const groups = useStore.getState().document.groups;
      const clickAnimIds = findClickAnimationsForEntity(id, animations, groups);
      for (const animId of clickAnimIds) {
        toggleClickAnimation(animId);
      }
    },
    [select, toggleSelection, toggleClickAnimation],
  );

  return (
    <group name="entities">
      {order.map((id) => {
        const entity = entities[id];
        if (!entity) return null;

        // Respect layer visibility (document) and the local layer-hide filter (UI).
        const layer = layers[entity.layerId];
        if (layer && !layer.visible) return null;
        if (hiddenLayerIds.has(entity.layerId)) return null;

        // Respect render-only UI hide override.
        if (hiddenEntityIds.has(id)) return null;

        return (
          <EntityRenderer
            key={id}
            entity={entity}
            selected={selectionSet.has(id)}
            onSelect={handleSelect}
          />
        );
      })}
    </group>
  );
}
