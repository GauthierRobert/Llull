// Plant-scale entities as the core render plan's buckets: one InstancedMesh per (prototype x material class x LOD), re-planned when the
// camera settles (hysteresis from the previous levels), frustum / pixel culled by the plan. Picks map `instanceId` to the entity id.
// Entities in `covered` are NOT drawn by the per-entity path (Entities.tsx excludes them).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Entity, EntityId, Material } from '@core/model/types';
import { type PlanScene, type RenderPlan, planRender } from '@core/geometry/renderPlan';
import { type PlanCamera, planCameraProblem } from '@core/geometry/renderPlanCamera';
import { type DisplayMode, useViewportStore } from '@ui/store';
import { isAdditiveSelect } from '../../selectClick';
import { useDisposable } from '../../useDisposable';
import { makeMaterialArgs, useBatchCapacity } from '../InstancedRenderer';
import { LodGeometryCache } from './LodGeometryCache';
import { type DrawBucket, drawBuckets, entityIdAt } from './plantBatchPlan';
import { writeBucketColours } from './plantInstanceColours';
import { bucketMatrices, type LocalBox } from './plantMatrices';

/** The camera must rest this long before the plan is recomputed (an orbit drag replans once, on release). */
const SETTLE_MS = 150;

interface PlantBatchRendererProps {
  scene: PlanScene;
  covered: ReadonlySet<EntityId>;
  entities: Readonly<Record<EntityId, Entity>>;
  materials: Readonly<Record<string, Material>>;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

/** One shaded material per (display mode, material class), created lazily and disposed together. */
class PlantMaterials {
  private readonly byClass = new Map<string, THREE.MeshStandardMaterial>();
  constructor(
    private readonly displayMode: DisplayMode,
    private readonly materials: Readonly<Record<string, Material>>,
  ) {}
  get(materialClass: string): THREE.MeshStandardMaterial {
    let material = this.byClass.get(materialClass);
    if (material === undefined) {
      const pbr = Object.hasOwn(this.materials, materialClass) ? this.materials[materialClass] : undefined;
      material = new THREE.MeshStandardMaterial(makeMaterialArgs(this.displayMode, pbr));
      this.byClass.set(materialClass, material);
    }
    return material;
  }
  dispose(): void {
    for (const material of this.byClass.values()) material.dispose();
    this.byClass.clear();
  }
}

/** The plan camera of the r3f camera in document coordinates (`group` carries the floating-origin offset), or null while it is unplannable. */
function readPlanCamera(camera: THREE.Camera, group: THREE.Object3D, widthPx: number, heightPx: number): PlanCamera | null {
  group.updateWorldMatrix(true, false);
  const eye = group.worldToLocal(camera.position.clone());
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const base = {
    eye: [eye.x, eye.y, eye.z] as const,
    direction: [direction.x, direction.y, direction.z] as const,
    up: [up.x, up.y, up.z] as const,
    widthPx,
    heightPx,
  };
  const planCamera: PlanCamera =
    camera instanceof THREE.OrthographicCamera
      ? { ...base, projection: 'orthographic', fovDeg: 0, viewHeight: (camera.top - camera.bottom) / camera.zoom }
      : { ...base, projection: 'perspective', fovDeg: (camera as THREE.PerspectiveCamera).fov, viewHeight: 0 };
  return planCameraProblem(planCamera) === null ? planCamera : null;
}

interface BucketMeshProps {
  bucket: DrawBucket;
  entities: Readonly<Record<EntityId, Entity>>;
  cache: LodGeometryCache;
  material: THREE.MeshStandardMaterial;
  materialColour: string | undefined;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

function PlantBucketMesh({
  bucket,
  entities,
  cache,
  material,
  materialColour,
  selectionSet,
  onSelect,
}: BucketMeshProps): React.ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = bucket.ids.length;
  const capacity = useBatchCapacity(count);
  const first = entities[bucket.ids[0] ?? ''];
  const geometry = first === undefined ? undefined : cache.geometry(bucket.prototypeKey, bucket.lod, first);

  // A new `args` makes r3f build a NEW InstancedMesh: matrices and colours are rewritten on every identity change.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const placements = bucket.ids.map((id) => entities[id]).filter((entity): entity is Entity => entity !== undefined);
    const boxes =
      bucket.lod === 2 ? placements.map((entity, index): LocalBox => cache.localBox(bucket.prototypes[index] ?? '', entity)) : undefined;
    mesh.instanceMatrix.array.set(bucketMatrices(placements, boxes));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }, [bucket, entities, cache, geometry, material, capacity]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh) writeBucketColours(mesh, bucket.ids, entities, materialColour, selectionSet);
  }, [bucket, entities, materialColour, selectionSet, geometry, material, capacity]);

  if (geometry === undefined || count === 0) return null;

  function handleClick(event: ThreeEvent<MouseEvent>): void {
    event.stopPropagation();
    const id = entityIdAt(bucket, event.instanceId);
    if (id !== undefined) onSelect(id, isAdditiveSelect(event.nativeEvent));
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, capacity]}
      count={count}
      onClick={handleClick}
      castShadow={bucket.lod < 2}
      receiveShadow
    />
  );
}

/** Re-plans on mount / scene change, and `SETTLE_MS` after the camera (or the canvas size) stops changing. */
function usePlan(scene: PlanScene, group: React.RefObject<THREE.Group | null>): RenderPlan | null {
  const { camera, size, invalidate } = useThree();
  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const previous = useRef<{ scene: PlanScene; levels: Uint8Array } | null>(null);
  const seen = useRef({ matrix: new THREE.Matrix4(), fov: 0, zoom: 0, width: 0, height: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const replan = useCallback((): void => {
    const root = group.current;
    if (!root) return;
    const planCamera = readPlanCamera(camera, root, size.width, size.height);
    if (planCamera === null) return;
    const previousLevels = previous.current?.scene === scene ? previous.current.levels : undefined;
    const next = planRender(scene, planCamera, { multiDraw: true, quality: 'medium', ...(previousLevels && { previousLevels }) });
    previous.current = { scene, levels: next.levels };
    setPlan(next);
    invalidate();
  }, [camera, size.width, size.height, scene, group, invalidate]);

  useEffect(() => {
    replan();
  }, [replan]);

  useFrame(() => {
    const last = seen.current;
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 0;
    const same =
      last.matrix.equals(camera.matrixWorld) &&
      last.fov === fov &&
      last.zoom === camera.zoom &&
      last.width === size.width &&
      last.height === size.height;
    if (same) return;
    last.matrix.copy(camera.matrixWorld);
    last.fov = fov;
    last.zoom = camera.zoom;
    last.width = size.width;
    last.height = size.height;
    clearTimeout(timer.current);
    timer.current = setTimeout(replan, SETTLE_MS);
  });

  useEffect(() => () => clearTimeout(timer.current), []);
  return plan;
}

export function PlantBatchRenderer({
  scene,
  covered,
  entities,
  materials,
  selectionSet,
  onSelect,
}: PlantBatchRendererProps): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);
  const displayMode = useViewportStore((s) => s.displayMode);
  const plan = usePlan(scene, groupRef);
  const cache = useDisposable(() => new LodGeometryCache(), []);
  const plantMaterials = useDisposable(() => new PlantMaterials(displayMode, materials), [displayMode, materials]);

  const buckets = useMemo(() => (plan === null ? [] : drawBuckets(scene, plan, covered)), [scene, plan, covered]);

  // Prototypes that left the scene free their geometries.
  useEffect(() => cache.retain(new Set(scene.prototypeKeys)), [cache, scene]);

  return (
    <group ref={groupRef} name="plant-batches">
      {buckets.map((bucket) => (
        <PlantBucketMesh
          key={bucket.key}
          bucket={bucket}
          entities={entities}
          cache={cache}
          material={plantMaterials.get(bucket.materialClass)}
          materialColour={
            displayMode === 'shaded' && Object.hasOwn(materials, bucket.materialClass) ? materials[bucket.materialClass]?.color : undefined
          }
          selectionSet={selectionSet}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}
