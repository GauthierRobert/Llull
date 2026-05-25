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
import { BoxMesh } from './entities/BoxMesh';
import { CylinderMesh } from './entities/CylinderMesh';
import { SphereMesh } from './entities/SphereMesh';
import { ExtrusionMesh } from './entities/ExtrusionMesh';
import { MeshSolidMesh } from './entities/MeshSolidMesh';

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

  // Render-only visibility override — never touches the document (PRIME DIRECTIVE).
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);

  /**
   * Called by each mesh on click.
   * Plain click → single-select; Shift/Ctrl/Meta click → toggle (multi-select).
   */
  const handleSelect = useCallback(
    (id: EntityId, additive: boolean): void => {
      if (additive) {
        toggleSelection(id);
      } else {
        select([id]);
      }
    },
    [select, toggleSelection],
  );

  return (
    <group name="entities">
      {order.map((id) => {
        const entity = entities[id];
        if (!entity) return null;

        // Respect layer visibility.
        const layer = layers[entity.layerId];
        if (layer && !layer.visible) return null;

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
