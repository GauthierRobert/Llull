// Plant-scale entities as the core render plan's buckets: one InstancedMesh per (prototype x material class x LOD). The plan (frustum /
// pixel culled, hysteresis) comes from `usePlantPlan`; this component only draws `covered` entities of buckets that belong to the same
// scene as the plan. Entities in `covered` are NOT drawn by the per-entity path (Entities.tsx excludes them).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { DisplayModel } from '@core/model/display';
import type { Entity, EntityId, Material, Vec3 } from '@core/model/types';
import { type DisplayMode, useViewportStore } from '@ui/store';
import { useDisposable } from '../../useDisposable';
import { makeMaterialArgs } from '../InstancedRenderer';
import { LodGeometryCache } from './LodGeometryCache';
import { useRenderQuality } from '../useRenderQuality';
import { captureAtlas } from './impostorCapture';
import { ImpostorAtlasCache, type AtlasCapture } from './ImpostorAtlasCache';
import { ImpostorMaterials } from './plantImpostorMaterial';
import { PlantBucketMesh } from './PlantBucketMesh';
import { type DrawBucket, drawBuckets } from './plantBatchPlan';
import { useStableByKey } from '../../useStableByKey';
import { bucketSurface, classSurfacesKey, planClassSurfaces, type PlantSurface } from './plantClassSurfaces';
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
  /** Test seam: the atlas capture (default: the GPU capture of the canvas renderer). */
  atlasCapture?: AtlasCapture;
}

/** One shaded material per bucket (x-ray opacity is per bucket), created lazily and disposed together. */
class PlantMaterials {
  private readonly byBucket = new Map<string, THREE.MeshStandardMaterial>();
  constructor(
    private readonly displayMode: DisplayMode,
    private readonly materials: Readonly<Record<string, Material>>,
    private readonly classes: ReadonlyMap<string, PlantSurface>,
  ) {}
  get(bucket: DrawBucket): THREE.MeshStandardMaterial {
    let material = this.byBucket.get(bucket.key);
    if (material === undefined) {
      const pbr = bucketSurface(bucket.materialClass, this.materials, this.classes);
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

function bucketMaterial(
  bucket: DrawBucket,
  shaded: PlantMaterials,
  impostorMaterials: ImpostorMaterials,
  atlases: ImpostorAtlasCache,
): THREE.Material {
  const atlas = bucket.impostor === true ? atlases.peek(bucket.prototypeKey) : null;
  return atlas === null ? shaded.get(bucket) : impostorMaterials.get(bucket.prototypeKey, atlas);
}

export function PlantBatchRenderer({
  plan,
  covered,
  entities,
  materials,
  display,
  selectionSet,
  onSelect,
  atlasCapture,
}: PlantBatchRendererProps): React.ReactElement {
  const displayMode = useViewportStore((s) => s.displayMode);
  const cache = useDisposable(() => new LodGeometryCache(), []);
  const gl = useThree((s) => s.gl);
  const { impostors } = useRenderQuality();
  const atlases = useDisposable(() => new ImpostorAtlasCache(atlasCapture ?? captureAtlas(gl)), [gl, atlasCapture]);
  const impostorMaterials = useDisposable(() => new ImpostorMaterials(), []);
  // Scene indices drawn as impostors by the last plan (hysteresis); reset with the scene.
  const held = useRef<{ scene: PlantPlan['scene']; members: Set<number> }>({ scene: plan.scene, members: new Set() });
  const impostorsOn = impostors && displayMode === 'shaded';
  const buckets = useMemo(() => {
    if (held.current.scene !== plan.scene) held.current = { scene: plan.scene, members: new Set() };
    const options = impostorsOn
      ? {
          camera: plan.camera,
          held: held.current.members,
          // The atlas is captured on first use (cached per prototype); a prototype that failed to capture keeps its real mesh.
          available: (prototypeKey: string, entityId: EntityId): boolean => {
            const entity = entities[entityId];
            if (entity === undefined) return false;
            return atlases.atlas(prototypeKey, cache.geometry(prototypeKey, 1, entity), cache.localBox(prototypeKey, entity)) !== null;
          },
        }
      : undefined;
    const result = drawBuckets(plan.scene, plan.plan, covered, plan.moving, options);
    held.current.members = new Set(result.filter((bucket) => bucket.impostor === true).flatMap((bucket) => bucket.members));
    return result;
  }, [plan, covered, impostorsOn, atlases, cache, entities]);
  // Only the surfaces of the classes the plan uses: an unrelated display change (a profile, another class) keeps every bucket material.
  const usedClasses = useMemo(() => planClassSurfaces(plan.scene.materialClasses, display), [plan.scene.materialClasses, display]);
  const classes = useStableByKey(usedClasses, classSurfacesKey(usedClasses));
  const plantMaterials = useDisposable(() => new PlantMaterials(displayMode, materials, classes), [displayMode, materials, classes]);

  // Prototypes that left the scene free their geometries.
  const { scene } = plan;
  useEffect(() => {
    const live = new Set(scene.prototypeKeys);
    cache.retain(live);
    atlases.retain(live);
  }, [cache, atlases, scene]);
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
          material={bucketMaterial(bucket, plantMaterials, impostorMaterials, atlases)}
          materialColour={displayMode === 'shaded' ? bucketSurface(bucket.materialClass, materials, classes)?.color : undefined}
          displayMode={displayMode}
          selectionSet={selectionSet}
          onSelect={onSelect}
          candidates={candidates}
        />
      ))}
    </group>
  );
}
