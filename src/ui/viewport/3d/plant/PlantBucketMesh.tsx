// One InstancedMesh of a draw bucket: matrices, colours, x-ray opacity and picking (`instanceId` -> entity id).

import { useEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type * as THREE from 'three';
import type { Entity, EntityId } from '@core/model/types';
import type { DisplayMode } from '@ui/store';
import { useTintStore } from '@ui/store/tintStore';
import { isAdditiveSelect } from '../../selectClick';
import { XRAY_OPACITY } from '../../viewportPalette';
import { useBatchCapacity } from '../InstancedRenderer';
import { useRenderQuality } from '../useRenderQuality';
import type { LodGeometryCache } from './LodGeometryCache';
import { type DrawBucket, entityIdAt } from './plantBatchPlan';
import { writeBucketColours } from './plantInstanceColours';
import { bucketMatrices, type LocalBox } from './plantMatrices';
import { bucketRaycast, type CandidateSource } from './plantPick';

export interface PlantBucketMeshProps {
  bucket: DrawBucket;
  entities: Readonly<Record<EntityId, Entity>>;
  cache: LodGeometryCache;
  /** The bucket's material: shaded standard material, or the impostor shader for an impostor bucket. */
  material: THREE.Material;
  materialColour: string | undefined;
  displayMode: DisplayMode;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
  /** BVH ray candidates of the scene the bucket belongs to. */
  candidates: CandidateSource;
}

export function PlantBucketMesh({
  bucket,
  entities,
  cache,
  material,
  materialColour,
  displayMode,
  selectionSet,
  onSelect,
  candidates,
}: PlantBucketMeshProps): React.ReactElement | null {
  // Tints rewrite the colour buffer only (no plan, no matrix rewrite); read here so small documents never render this component.
  const tints = useTintStore((s) => s.tints);
  const { keyShadows, plantShadowMaxLod } = useRenderQuality();
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = bucket.ids.length;
  const capacity = useBatchCapacity(count);
  const first = entities[bucket.ids[0] ?? ''];
  const impostor = bucket.impostor === true;
  const realGeometry = first === undefined ? undefined : cache.geometry(bucket.prototypeKey, bucket.lod, first);
  const geometry = impostor ? cache.impostorQuad() : realGeometry;

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
    if (mesh) writeBucketColours(mesh, bucket.ids, entities, materialColour, selectionSet, tints);
  }, [bucket, entities, materialColour, selectionSet, tints, geometry, material, capacity]);

  // No per-instance opacity: in x-ray, any selected entity raises the whole bucket's opacity (as InstancedRenderer).
  useEffect(() => {
    if (displayMode !== 'xray' || impostor) return;
    (material as THREE.MeshStandardMaterial).opacity = bucket.ids.some((id) => selectionSet.has(id))
      ? XRAY_OPACITY.selected
      : XRAY_OPACITY.idle;
    material.needsUpdate = true;
  }, [displayMode, bucket, selectionSet, material, impostor]);

  const raycast = useMemo(
    () => bucketRaycast(bucket, candidates, impostor ? realGeometry : undefined),
    [bucket, candidates, impostor, realGeometry],
  );

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
      userData={{ instanceIds: bucket.ids }}
      onClick={handleClick}
      raycast={raycast}
      castShadow={!impostor && bucket.lod <= plantShadowMaxLod}
      frustumCulled={!impostor}
      receiveShadow={keyShadows && !impostor}
    />
  );
}
