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
 *
 * ## Instanced rendering (P2)
 * Entities whose kind is batchable (box / cylinder / sphere) are grouped by
 * `groupEntitiesForInstancing` and rendered as InstancedMesh batches via
 * `<InstancedRenderer>`. This collapses N identical-geometry entities into 1
 * draw call per geometry+color group.
 *
 * Non-batchable entities (extrusion, mesh, cone, torus, wedge, pyramid, and all
 * 2D kinds) continue to use per-entity mesh branches (EntityRenderer).
 *
 * Expected draw-call delta: 100 identical boxes → 100 draw calls (before) vs
 * 1 draw call (after). Mixed scenes with N distinct groups → N draw calls.
 */

import { useCallback, useMemo } from 'react';
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
import { TextMesh } from './entities/TextMesh';
import { isBatchable, groupEntitiesForInstancing } from './grouping';
import { InstancedRenderer } from './InstancedRenderer';

interface EntitiesProps {
  document: CadDocument;
}

/**
 * Render a single entity; one pure branch per `kind`.
 * Used only for NON-batchable kinds — batchable kinds (box/cylinder/sphere)
 * are rendered by InstancedRenderer.
 */
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
    case 'text':
      return <TextMesh entity={entity} selected={selected} onSelect={onSelect} />;
    default:
      // 2D shape kinds (line/arc/circle/…) are drawn by the 2D viewport (Lane 3 / D1),
      // not in the 3D scene. Keeping a tolerant default lets the Entity union grow
      // without breaking this branch (architecture L7).
      return null;
  }
}

export function Entities({ document }: EntitiesProps): React.ReactElement {
  const { order, entities, layers, selection } = document;
  const selectionSet = useMemo(() => new Set<EntityId>(selection), [selection]);

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

  // --- Compute visible entity list (applies all visibility filters) ---
  const visibleEntities = useMemo(() => {
    return order
      .map((id) => entities[id])
      .filter((entity): entity is Entity => {
        if (!entity) return false;
        const layer = layers[entity.layerId];
        if (layer && !layer.visible) return false;
        if (hiddenLayerIds.has(entity.layerId)) return false;
        if (hiddenEntityIds.has(entity.id)) return false;
        return true;
      });
  }, [order, entities, layers, hiddenLayerIds, hiddenEntityIds]);

  // --- Split: batchable kinds (box/cylinder/sphere) go to InstancedRenderer ---
  const batchableEntities = useMemo(
    () => visibleEntities.filter(isBatchable),
    [visibleEntities],
  );

  // --- Non-batchable kinds continue as per-entity meshes ---
  const nonBatchableEntities = useMemo(
    () => visibleEntities.filter((e) => !isBatchable(e)),
    [visibleEntities],
  );

  // --- Group batchable entities into InstancedMesh batches ---
  const batches = useMemo(
    () => groupEntitiesForInstancing(batchableEntities),
    [batchableEntities],
  );

  return (
    <group name="entities">
      {/* Instanced rendering: box / cylinder / sphere — one draw call per batch */}
      <InstancedRenderer
        batches={batches}
        selectionSet={selectionSet}
        onSelect={handleSelect}
      />

      {/* Per-entity rendering: non-batchable kinds (extrusion, mesh, cone, torus, wedge, pyramid) */}
      {nonBatchableEntities.map((entity) => (
        <EntityRenderer
          key={entity.id}
          entity={entity}
          selected={selectionSet.has(entity.id)}
          onSelect={handleSelect}
        />
      ))}
    </group>
  );
}
