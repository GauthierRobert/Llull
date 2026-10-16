// Batchable kinds (grouping.ts) as one InstancedMesh per batch (one draw call). Matrices + colors (selection tint)
// are written in an effect keyed on batch contents; a click's `instanceId` maps back through the id-sorted entities.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { EntityId } from '@core/model/types';
import { type DisplayMode, useViewportStore } from '@ui/store';
import { type InstanceBatch, entityIdFromInstanceId } from './grouping';
import { writeBatchInstances } from './instanceWriter';
import { buildCylinderGeometry, buildSphereGeometry } from './entities/primitiveGeometry';
import { useDisposable } from '../useDisposable';
import { isAdditiveSelect } from '../selectClick';
import { useStableByKey } from '../useStableByKey';
import { XRAY_OPACITY } from '../viewportPalette';

/** Geometry of a batch from its first entity (the grouping key guarantees shared params). */
export function makeGeometry(batch: InstanceBatch): THREE.BufferGeometry {
  const first = batch.entities[0];
  if (!first) return new THREE.BufferGeometry();

  switch (batch.kind) {
    case 'box':
      return first.kind === 'box' ? new THREE.BoxGeometry(...first.size) : new THREE.BufferGeometry();
    case 'cylinder':
      return first.kind === 'cylinder' ? buildCylinderGeometry(first.radius, first.height) : new THREE.BufferGeometry();
    case 'sphere':
      return first.kind === 'sphere' ? buildSphereGeometry(first.radius) : new THREE.BufferGeometry();
  }
}

const SHADED_MATERIAL_ARGS: THREE.MeshStandardMaterialParameters = {
  roughness: 0.45,
  metalness: 0.08,
  envMapIntensity: 0.8,
  wireframe: false,
  transparent: false,
  opacity: 1,
  depthWrite: true,
  side: THREE.FrontSide,
};

/** Material args per display mode (mirrors useMaterialProps); the batch material's PBR applies in shaded mode only. */
export function makeMaterialArgs(
  displayMode: DisplayMode,
  batchMaterial?: { roughness: number; metalness: number } | undefined,
): THREE.MeshStandardMaterialParameters {
  if (displayMode === 'wireframe') return { ...SHADED_MATERIAL_ARGS, wireframe: true };
  if (displayMode === 'xray') {
    return {
      ...SHADED_MATERIAL_ARGS,
      envMapIntensity: 0,
      transparent: true,
      opacity: XRAY_OPACITY.idle,
      depthWrite: false,
      side: THREE.DoubleSide,
    };
  }
  return { ...SHADED_MATERIAL_ARGS, ...(batchMaterial && { roughness: batchMaterial.roughness, metalness: batchMaterial.metalness }) };
}

interface InstanceBatchMeshProps {
  batch: InstanceBatch;
  selectionSet: ReadonlySet<EntityId>;
  displayMode: DisplayMode;
  onSelect: (id: EntityId, additive: boolean) => void;
}

/** Colors go through `instanceColor`; `vertexColors` stays off (primitives carry no color attribute → black). */
function InstanceBatchMesh({ batch, selectionSet, displayMode, onSelect }: InstanceBatchMeshProps): React.ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = batch.entities.length;

  // Batches are rebuilt every grouping pass; batch.key is the content identity.
  const geometryBatch = useStableByKey(batch, batch.key);
  const geometry = useDisposable(() => makeGeometry(geometryBatch), [geometryBatch]);

  const material = useDisposable(
    () => new THREE.MeshStandardMaterial(makeMaterialArgs(displayMode, batch.pbrMaterial)),
    [displayMode, batch.pbrMaterial],
  );

  // `args` changing (display mode → material, geometry, count) makes r3f construct a NEW InstancedMesh with identity
  // matrices and no colors: rewrite whenever any of them changes, not just the batch.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh) writeBatchInstances(mesh, batch, selectionSet);
  }, [batch, selectionSet, geometry, material, count]);

  // InstancedMesh has no per-instance opacity: in x-ray, any selected entity raises the whole batch's opacity.
  useEffect(() => {
    if (displayMode === 'xray') {
      const hasSelected = batch.entities.some((e) => selectionSet.has(e.id));
      material.opacity = hasSelected ? XRAY_OPACITY.selected : XRAY_OPACITY.idle;
      material.needsUpdate = true;
    }
  }, [displayMode, batch.entities, selectionSet, material]);

  if (count === 0) return null;

  function handleClick(e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation();
    const entityId = e.instanceId === undefined ? undefined : entityIdFromInstanceId(batch, e.instanceId);
    if (entityId) onSelect(entityId, isAdditiveSelect(e.nativeEvent));
  }

  return <instancedMesh ref={meshRef} args={[geometry, material, count]} onClick={handleClick} castShadow receiveShadow />;
}

interface InstancedRendererProps {
  batches: Map<string, InstanceBatch>;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

export function InstancedRenderer({ batches, selectionSet, onSelect }: InstancedRendererProps): React.ReactElement {
  const displayMode = useViewportStore((s) => s.displayMode);

  return (
    <group name="instanced-entities">
      {Array.from(batches.entries()).map(([key, batch]) => (
        <InstanceBatchMesh key={key} batch={batch} selectionSet={selectionSet} displayMode={displayMode} onSelect={onSelect} />
      ))}
    </group>
  );
}
