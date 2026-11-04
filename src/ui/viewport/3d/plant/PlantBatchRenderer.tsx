// Plant-scale entities as the core render plan's buckets: one InstancedMesh per (prototype x material class x LOD). The plan (frustum /
// pixel culled, hysteresis) comes from `usePlantPlan`; this component only draws `covered` entities of buckets that belong to the same
// scene as the plan. Entities in `covered` are NOT drawn by the per-entity path (Entities.tsx excludes them).

import { useCallback, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { DisplayModel } from '@core/model/display';
import type { Entity, EntityId, Material, Vec3 } from '@core/model/types';
import { type DisplayMode, useViewportStore } from '@ui/store';
import { useDisposable } from '../../useDisposable';
import { makeMaterialArgs } from '../InstancedRenderer';
import { LodGeometryCache } from './LodGeometryCache';
import { PlantBucketMesh } from './PlantBucketMesh';
import { type DrawBucket, drawBuckets } from './plantBatchPlan';
import { assignedClassOf } from '../review/materialClassAppearance';
import { prepareRayIndex, rayCandidates } from './plantRayIndex';
import type { PlantPlan } from './usePlantPlan';

interface PlantBatchRendererProps {
  plan: PlantPlan;
  covered: ReadonlySet<EntityId>;
  entities: Readonly<Record<EntityId, Entity>>;
  materials: Readonly<Record<string, Material>>;
  /** Material classes: a bucket of an assigned class takes the class's metalness and roughness. */
  display: DisplayModel | undefined;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

/** One shaded material per bucket (x-ray opacity is per bucket), created lazily and disposed together. */
class PlantMaterials {
  private readonly byBucket = new Map<string, THREE.MeshStandardMaterial>();
  constructor(
    private readonly displayMode: DisplayMode,
    private readonly materials: Readonly<Record<string, Material>>,
    private readonly display: DisplayModel | undefined,
  ) {}
  get(bucket: DrawBucket): THREE.MeshStandardMaterial {
    let material = this.byBucket.get(bucket.key);
    if (material === undefined) {
      const pbr = bucketSurface(bucket, this.materials, this.display);
      // Pushed back like SolidMeshShell, so lines drawn on the surface stay visible.
      material = new THREE.MeshStandardMaterial({
        ...makeMaterialArgs(this.displayMode, pbr),
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      this.byBucket.set(bucket.key, material);
    }
    return material;
  }
  dispose(): void {
    for (const material of this.byBucket.values()) material.dispose();
    this.byBucket.clear();
  }
}

/** The bucket's `materialClass` is an assigned display class id (its surface) or a document material id (its PBR, colour too). */
function bucketSurface(
  bucket: DrawBucket,
  materials: Readonly<Record<string, Material>>,
  display: DisplayModel | undefined,
): { roughness: number; metalness: number; color?: string } | undefined {
  const cls = assignedClassOf(display, bucket.ids[0] ?? '');
  if (cls !== undefined && cls.id === bucket.materialClass) return cls;
  return Object.hasOwn(materials, bucket.materialClass) ? materials[bucket.materialClass] : undefined;
}

export function PlantBatchRenderer({
  plan,
  covered,
  entities,
  materials,
  display,
  selectionSet,
  onSelect,
}: PlantBatchRendererProps): React.ReactElement {
  const displayMode = useViewportStore((s) => s.displayMode);
  const cache = useDisposable(() => new LodGeometryCache(), []);
  const plantMaterials = useDisposable(() => new PlantMaterials(displayMode, materials, display), [displayMode, materials, display]);
  const buckets = useMemo(() => drawBuckets(plan.scene, plan.plan, covered, plan.moving), [plan, covered]);

  // Prototypes that left the scene free their geometries.
  const { scene } = plan;
  useEffect(() => cache.retain(new Set(scene.prototypeKeys)), [cache, scene]);
  // Picking: the instance BVH of this scene, built in a later task, and the ray query every bucket of one pick shares.
  useEffect(() => prepareRayIndex(scene), [scene]);
  const candidates = useCallback((origin: Vec3, direction: Vec3) => rayCandidates(scene, origin, direction), [scene]);

  return (
    <group name="plant-batches">
      {buckets.map((bucket) => (
        <PlantBucketMesh
          key={bucket.key}
          bucket={bucket}
          entities={entities}
          cache={cache}
          material={plantMaterials.get(bucket)}
          materialColour={displayMode === 'shaded' ? bucketSurface(bucket, materials, display)?.color : undefined}
          displayMode={displayMode}
          selectionSet={selectionSet}
          onSelect={onSelect}
          candidates={candidates}
        />
      ))}
    </group>
  );
}
