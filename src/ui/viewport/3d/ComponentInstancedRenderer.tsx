// Pattern / assembly instances as InstancedMeshes per (component, child solid): matrices from the instance entities, colours with
// tints + selection, picking by `instanceId` -> instance entity id (selecting one instance, never the batch), hover, instance BVH
// picking and screen-space LOD tiers (componentBatch/).

import type { Entity, EntityId, Material } from '@core/model/types';
import { useViewportStore } from '@ui/store';
import type { ComponentBatchPlan } from './componentInstancePlan';
import { ComponentBatchMesh } from './componentBatch/ComponentBatchMesh';

interface ComponentInstancedRendererProps {
  plan: ComponentBatchPlan;
  entities: Readonly<Record<EntityId, Entity>>;
  materials: Readonly<Record<string, Material>>;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

export function ComponentInstancedRenderer({
  plan,
  entities,
  materials,
  selectionSet,
  onSelect,
}: ComponentInstancedRendererProps): React.ReactElement {
  const displayMode = useViewportStore((s) => s.displayMode);
  return (
    <group name="component-instances">
      {plan.batches.map((batch) => (
        <ComponentBatchMesh
          key={batch.key}
          batch={batch}
          entities={entities}
          materials={materials}
          displayMode={displayMode}
          selectionSet={selectionSet}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}
