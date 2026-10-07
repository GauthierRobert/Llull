/**
 * @layer ui/viewport/3d
 *
 * Maps `document.order` → a render branch per entity `kind` (architecture L7: every kind has one).
 * Layer-hidden and render-only hidden entities (UI store) are skipped; selection state is passed
 * to each branch. 2D kinds belong to the 2D viewport and render nothing here.
 *
 * Click: plain click → select([id]); Shift/Ctrl/Meta click → toggleSelection(id). A click also
 * toggles the `trigger:'click'` animations that target the entity (directly or through a group).
 *
 * Batchable kinds (box / cylinder / sphere, see grouping.ts) are drawn by InstancedRenderer as one
 * InstancedMesh per geometry+color group; every other kind uses a per-entity mesh branch.
 */

import { memo, useCallback, useMemo } from 'react';
import type { CadDocument, Entity, EntityId, InstanceEntity } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { animatedEntityIds, findClickAnimationsForEntity } from './animationClickHelpers';
import { isEntityVisible } from '../entityVisibility';
import { BoxMesh } from './entities/BoxMesh';
import { CylinderMesh } from './entities/CylinderMesh';
import { SphereMesh } from './entities/SphereMesh';
import { ExtrusionMesh } from './entities/ExtrusionMesh';
import { MeshSolidMesh } from './entities/MeshSolidMesh';
import { ConeMesh } from './entities/ConeMesh';
import { TorusMesh } from './entities/TorusMesh';
import { WedgeMesh } from './entities/WedgeMesh';
import { PyramidMesh } from './entities/PyramidMesh';
import { RevolutionMesh } from './entities/RevolutionMesh';
import { TextMesh } from './entities/TextMesh';
import { isBatchable, groupEntitiesForInstancing } from './grouping';
import { InstancedRenderer } from './InstancedRenderer';
import { GridAnnotations3D } from './GridAnnotations3D';
import { GRID_LAYER_NAME } from './gridAnnotations';
import { expandInstance } from '@core/commands/assemblies';
import type { PbrMaterial } from './useMaterialProps';

/**
 * Renders a single InstanceEntity by expanding it into world-space entities via
 * `expandInstance` and delegating to the same per-kind EntityRenderer branches.
 *
 * All sub-mesh clicks are intercepted and re-routed to the INSTANCE id so that
 * selection always targets the instance as a unit (not its expanded children).
 *
 * The expanded entity list is memoized on (componentId, position, rotation, scale)
 * so it is only recomputed when the instance transform or component changes (R9 / R7).
 *
 * @layer ui/viewport/3d
 * @pure of props — given the same instance + components, produces the same tree.
 */
function InstanceEntityRenderer({
  instance,
  document,
  selected,
  onSelect,
}: {
  instance: InstanceEntity;
  document: CadDocument;
  selected: boolean;
  onSelect: (id: EntityId, additive: boolean) => void;
}): React.ReactElement | null {
  const component = document.components[instance.componentId];

  // Route all sub-entity clicks to the instance id so the gizmo and selection
  // operate on the instance as a unit. Must be declared before any early return
  // to satisfy the Rules of Hooks (react-hooks/rules-of-hooks).
  const handleSubSelect = useCallback(
    (_childId: EntityId, additive: boolean): void => {
      onSelect(instance.id, additive);
    },
    [instance.id, onSelect],
  );

  const expandedEntities = useMemo(
    () => (component ? expandInstance(instance, component) : []),
    [component, instance],
  );

  if (!component || expandedEntities.length === 0) return null;

  return (
    <group name={`instance-${instance.id}`}>
      {expandedEntities.map((entity) => (
        <EntityRenderer
          key={entity.id}
          entity={entity}
          selected={selected}
          onSelect={handleSubSelect}
        />
      ))}
    </group>
  );
}

/**
 * Render a single entity; one pure branch per `kind`.
 * Used only for NON-batchable kinds — batchable kinds (box/cylinder/sphere)
 * are rendered by InstancedRenderer.
 *
 * Memoized: `document` is passed ONLY to `instance` entities, so a selection change does not
 * re-render every other mesh branch.
 */
const EntityRenderer = memo(function EntityRenderer({
  entity,
  selected,
  onSelect,
  pbrMaterial,
  document,
}: {
  entity: Entity;
  selected: boolean;
  onSelect: (id: EntityId, additive: boolean) => void;
  pbrMaterial?: PbrMaterial | undefined;
  document?: CadDocument | undefined;
}): React.ReactElement | null {
  const shared = { selected, onSelect, pbrMaterial };
  switch (entity.kind) {
    case 'box':
      return <BoxMesh entity={entity} {...shared} />;
    case 'cylinder':
      return <CylinderMesh entity={entity} {...shared} />;
    case 'sphere':
      return <SphereMesh entity={entity} {...shared} />;
    case 'extrusion':
      return <ExtrusionMesh entity={entity} {...shared} />;
    case 'mesh':
      return <MeshSolidMesh entity={entity} {...shared} />;
    case 'cone':
      return <ConeMesh entity={entity} {...shared} />;
    case 'torus':
      return <TorusMesh entity={entity} {...shared} />;
    case 'wedge':
      return <WedgeMesh entity={entity} {...shared} />;
    case 'pyramid':
      return <PyramidMesh entity={entity} {...shared} />;
    case 'revolution':
      return <RevolutionMesh entity={entity} {...shared} />;
    case 'text':
      return <TextMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'instance':
      // `document` is required for the instance branch — it is always passed from Entities.
      if (!document) return null;
      return (
        <InstanceEntityRenderer
          instance={entity}
          document={document}
          selected={selected}
          onSelect={onSelect}
        />
      );
    default:
      // 2D shape kinds (line/arc/circle/…) are drawn by the 2D viewport (Viewport2D),
      // not in the 3D scene. Keeping a tolerant default lets the Entity union grow
      // without breaking this branch (architecture L7).
      return null;
  }
});

export function Entities(): React.ReactElement {
  const document = useStore((s) => s.document);
  const { order, entities, layers, selection, materials, animations, groups } = document;
  const selectionSet = useMemo(() => new Set<EntityId>(selection), [selection]);

  const select = useStore((s) => s.select);
  const toggleSelection = useStore((s) => s.toggleSelection);

  // Render-only visibility overrides — never touch the document (PRIME DIRECTIVE).
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const toggleClickAnimation = useViewportStore((s) => s.toggleClickAnimation);

  // Called by each mesh on click: plain click → single-select; Shift/Ctrl/Meta → toggle. Also
  // toggles the `trigger:'click'` animations targeting this entity (directly or via a group).
  const handleSelect = useCallback(
    (id: EntityId, additive: boolean): void => {
      if (additive) toggleSelection(id);
      else select([id]);

      const { animations, groups } = useStore.getState().document;
      for (const animationId of findClickAnimationsForEntity(id, animations, groups)) {
        toggleClickAnimation(animationId);
      }
    },
    [select, toggleSelection, toggleClickAnimation],
  );

  const visibleEntities = useMemo(() => {
    return order
      .map((id) => entities[id])
      .filter(
        (entity): entity is Entity =>
          entity !== undefined && isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds),
      );
  }, [order, entities, layers, hiddenLayerIds, hiddenEntityIds]);

  // Pass the materials map so batches can carry per-batch PBR overrides.
  // Animated entities are located by scene-object name, so they take the per-entity path.
  const animatedIds = useMemo(() => animatedEntityIds(animations, groups), [animations, groups]);
  const batches = useMemo(
    () =>
      groupEntitiesForInstancing(
        visibleEntities.filter((entity) => !animatedIds.has(entity.id)),
        materials,
      ),
    [visibleEntities, animatedIds, materials],
  );
  const nonBatchableEntities = useMemo(
    () =>
      visibleEntities.filter(
        (entity) =>
          (!isBatchable(entity) || animatedIds.has(entity.id)) &&
          layers[entity.layerId]?.name !== GRID_LAYER_NAME,
      ),
    [visibleEntities, animatedIds, layers],
  );

  return (
    <group name="entities">
      {/* Structural grid (S-GRID): screen-space lines + camera-facing labelled bubbles */}
      <GridAnnotations3D document={document} />

      {/* Instanced rendering: box / cylinder / sphere — one draw call per batch */}
      <InstancedRenderer batches={batches} selectionSet={selectionSet} onSelect={handleSelect} />

      {/* Per-entity rendering: non-batchable kinds (extrusion, mesh, cone, torus, wedge, pyramid, instance) */}
      {nonBatchableEntities.map((entity) => {
        const material = entity.materialId ? materials[entity.materialId] : undefined;
        return (
          <EntityRenderer
            key={entity.id}
            entity={entity}
            selected={selectionSet.has(entity.id)}
            onSelect={handleSelect}
            document={entity.kind === 'instance' ? document : undefined}
            pbrMaterial={material}
          />
        );
      })}
    </group>
  );
}
