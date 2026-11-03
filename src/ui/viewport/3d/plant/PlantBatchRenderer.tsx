// Plant-scale entities as the core render plan's buckets: one InstancedMesh per (prototype x material class x LOD). The plan (frustum /
// pixel culled, hysteresis) comes from `usePlantPlan`; this component only draws `covered` entities of buckets that belong to the same
// scene as the plan. Entities in `covered` are NOT drawn by the per-entity path (Entities.tsx excludes them).

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Entity, EntityId, Material } from '@core/model/types';
import { type DisplayMode, useViewportStore } from '@ui/store';
import { useDisposable } from '../../useDisposable';
import { makeMaterialArgs } from '../InstancedRenderer';
import { LodGeometryCache } from './LodGeometryCache';
import { PlantBucketMesh } from './PlantBucketMesh';
import { drawBuckets } from './plantBatchPlan';
import type { PlantPlan } from './usePlantPlan';

interface PlantBatchRendererProps {
  plan: PlantPlan;
  covered: ReadonlySet<EntityId>;
  entities: Readonly<Record<EntityId, Entity>>;
  materials: Readonly<Record<string, Material>>;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

/** One shaded material per bucket (x-ray opacity is per bucket), created lazily and disposed together. */
class PlantMaterials {
  private readonly byBucket = new Map<string, THREE.MeshStandardMaterial>();
  constructor(
    private readonly displayMode: DisplayMode,
    private readonly materials: Readonly<Record<string, Material>>,
  ) {}
  get(bucketKey: string, materialClass: string): THREE.MeshStandardMaterial {
    let material = this.byBucket.get(bucketKey);
    if (material === undefined) {
      const pbr = Object.hasOwn(this.materials, materialClass) ? this.materials[materialClass] : undefined;
      // Pushed back like SolidMeshShell, so lines drawn on the surface stay visible.
      material = new THREE.MeshStandardMaterial({
        ...makeMaterialArgs(this.displayMode, pbr),
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      this.byBucket.set(bucketKey, material);
    }
    return material;
  }
  dispose(): void {
    for (const material of this.byBucket.values()) material.dispose();
    this.byBucket.clear();
  }
}

export function PlantBatchRenderer({
  plan,
  covered,
  entities,
  materials,
  selectionSet,
  onSelect,
}: PlantBatchRendererProps): React.ReactElement {
  const displayMode = useViewportStore((s) => s.displayMode);
  const cache = useDisposable(() => new LodGeometryCache(), []);
  const plantMaterials = useDisposable(() => new PlantMaterials(displayMode, materials), [displayMode, materials]);
  const buckets = useMemo(() => drawBuckets(plan.scene, plan.plan, covered, plan.moving), [plan, covered]);

  // Prototypes that left the scene free their geometries.
  const { scene } = plan;
  useEffect(() => cache.retain(new Set(scene.prototypeKeys)), [cache, scene]);

  return (
    <group name="plant-batches">
      {buckets.map((bucket) => (
        <PlantBucketMesh
          key={bucket.key}
          bucket={bucket}
          entities={entities}
          cache={cache}
          material={plantMaterials.get(bucket.key, bucket.materialClass)}
          materialColour={
            displayMode === 'shaded' && Object.hasOwn(materials, bucket.materialClass) ? materials[bucket.materialClass]?.color : undefined
          }
          displayMode={displayMode}
          selectionSet={selectionSet}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}
