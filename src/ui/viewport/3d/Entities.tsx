// `document.order` → one render branch per `kind` (L7). Batchable kinds (grouping.ts) draw through InstancedRenderer;
// animated, finished (textured) and decaled entities take the per-entity path. A click also toggles the entity's
// `trigger:'click'` animations (directly or via a group).

import { memo, useCallback, useMemo } from 'react';
import type { CadDocument, Entity, EntityId, InstanceEntity, SolidKind } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { useSelectionSet } from '@ui/store/selectionHooks';
import { animatedEntityIds, findClickAnimationsForEntity } from './animationClickHelpers';
import { isEntityVisible } from '../entityVisibility';
import { DecalOverlay } from './entities/DecalOverlay';
import { TextMesh } from './entities/TextMesh';
import { SOLID_MESHES, type SolidMeshBranch } from './entities/solidMeshes';
import { Shape2DRenderer } from '../2d/Shape2DRenderer';
import { isBatchable, groupEntitiesForInstancing } from './grouping';
import { InstancedRenderer } from './InstancedRenderer';
import { GridAnnotations3D } from './GridAnnotations3D';
import { GRID_LAYER_NAME } from './gridAnnotations';
import { expandInstance } from '@core/geometry/instanceExpansion';
import type { PbrMaterial } from './useMaterialProps';

/** Expands an instance; every sub-mesh click selects the INSTANCE id so it moves as a unit. */
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

  const handleSubSelect = useCallback(
    (_childId: EntityId, additive: boolean): void => {
      onSelect(instance.id, additive);
    },
    [instance.id, onSelect],
  );

  const expandedEntities = useMemo(() => (component ? expandInstance(instance, component) : []), [component, instance]);

  if (!component || expandedEntities.length === 0) return null;

  return (
    <group name={`instance-${instance.id}`}>
      {expandedEntities.map((entity) => (
        <EntityRenderer key={entity.id} entity={entity} selected={selected} onSelect={handleSubSelect} />
      ))}
    </group>
  );
}

/** Memoized: only `instance` entities get `document`, so a selection change does not re-render every branch. */
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
  if (entity.kind in SOLID_MESHES) {
    const Mesh = SOLID_MESHES[entity.kind as SolidKind] as SolidMeshBranch<Entity>;
    const mesh = <Mesh entity={entity} selected={selected} onSelect={onSelect} pbrMaterial={pbrMaterial} />;
    if (entity.decals === undefined) return mesh;
    return (
      <>
        {mesh}
        <DecalOverlay entity={entity} />
      </>
    );
  }
  switch (entity.kind) {
    case 'text':
      return <TextMesh entity={entity} selected={selected} onSelect={onSelect} />;
    case 'instance':
      if (!document) return null;
      return <InstanceEntityRenderer instance={entity} document={document} selected={selected} onSelect={onSelect} />;
    default:
      // 2D kinds draw on their own work plane through the 2D view's renderers (L7).
      return <Shape2DRenderer entity={entity} selected={selected} />;
  }
});

export function Entities(): React.ReactElement {
  const document = useStore((s) => s.document);
  const { order, entities, layers, materials, animations, groups } = document;
  const selectionSet = useSelectionSet();

  const select = useStore((s) => s.select);
  const toggleSelection = useStore((s) => s.toggleSelection);

  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const toggleClickAnimation = useViewportStore((s) => s.toggleClickAnimation);

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
      .filter((entity): entity is Entity => entity !== undefined && isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds));
  }, [order, entities, layers, hiddenLayerIds, hiddenEntityIds]);

  const hasFinish = useCallback(
    (entity: Entity): boolean =>
      entity.decals !== undefined || (entity.materialId !== undefined && materials[entity.materialId]?.finish !== undefined),
    [materials],
  );
  const animatedIds = useMemo(() => animatedEntityIds(animations, groups), [animations, groups]);
  const batches = useMemo(
    () =>
      groupEntitiesForInstancing(
        visibleEntities.filter((entity) => !animatedIds.has(entity.id) && !hasFinish(entity)),
        materials,
      ),
    [visibleEntities, animatedIds, materials, hasFinish],
  );
  const nonBatchableEntities = useMemo(
    () =>
      visibleEntities.filter(
        (entity) =>
          (!isBatchable(entity) || animatedIds.has(entity.id) || hasFinish(entity)) && layers[entity.layerId]?.name !== GRID_LAYER_NAME,
      ),
    [visibleEntities, animatedIds, layers, hasFinish],
  );

  return (
    <group name="entities">
      <GridAnnotations3D document={document} />

      <InstancedRenderer batches={batches} selectionSet={selectionSet} onSelect={handleSelect} />

      {nonBatchableEntities.map((entity) => (
        <EntityRenderer
          key={entity.id}
          entity={entity}
          selected={selectionSet.has(entity.id)}
          onSelect={handleSelect}
          document={entity.kind === 'instance' ? document : undefined}
          pbrMaterial={entity.materialId ? materials[entity.materialId] : undefined}
        />
      ))}
    </group>
  );
}
