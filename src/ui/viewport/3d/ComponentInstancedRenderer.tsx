// Pattern / assembly instances as one InstancedMesh per (component, child solid): matrices from the instance entities, colours with
// tints + selection, picking by `instanceId` -> instance entity id (selecting one instance, never the batch).

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { solidTriangles } from '@core/geometry/solidTriangles';
import type { Entity, EntityId, Material } from '@core/model/types';
import { type DisplayMode, useViewportStore } from '@ui/store';
import { useTintStore } from '@ui/store/tintStore';
import { isAdditiveSelect } from '../selectClick';
import { useDisposable } from '../useDisposable';
import { XRAY_OPACITY } from '../viewportPalette';
import { buildTriangleSoupGeometry } from './entities/meshSolidGeometry';
import type { ComponentBatch, ComponentBatchPlan } from './componentInstancePlan';
import { makeMaterialArgs, useBatchCapacity } from './InstancedRenderer';
import { writeBucketColours } from './plant/plantInstanceColours';
import { isClippedAway } from './review/activeClipPlanes';

const DUMMY = new THREE.Object3D();

/** Instance matrices (scale, then rotate about the component origin, then translate: `instanceToWorld`) into the mesh, then refresh bounds. */
function writeComponentMatrices(
  mesh: THREE.InstancedMesh,
  ids: readonly EntityId[],
  entities: Readonly<Record<EntityId, Entity>>,
): void {
  ids.forEach((id, index) => {
    const instance = entities[id];
    if (instance === undefined) return;
    DUMMY.position.set(instance.position[0], instance.position[1], instance.position[2]);
    DUMMY.rotation.set(instance.rotation[0], instance.rotation[1], instance.rotation[2]);
    const scale = instance.kind === 'instance' ? instance.scale : undefined;
    DUMMY.scale.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
    DUMMY.updateMatrix();
    mesh.setMatrixAt(index, DUMMY.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
}

interface BatchMeshProps {
  batch: ComponentBatch;
  entities: Readonly<Record<EntityId, Entity>>;
  materials: Readonly<Record<string, Material>>;
  displayMode: DisplayMode;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

function ComponentBatchMesh({
  batch,
  entities,
  materials,
  displayMode,
  selectionSet,
  onSelect,
}: BatchMeshProps): React.ReactElement | null {
  const tints = useTintStore((s) => s.tints);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = batch.ids.length;
  const capacity = useBatchCapacity(count);
  const material = batch.child.materialId === undefined ? undefined : materials[batch.child.materialId];

  const geometry = useDisposable(() => buildTriangleSoupGeometry(solidTriangles(batch.child)) ?? new THREE.BufferGeometry(), [batch.child]);
  const surface = useDisposable(() => new THREE.MeshStandardMaterial(makeMaterialArgs(displayMode, material)), [displayMode, material]);

  // A new `args` makes r3f build a NEW InstancedMesh: matrices and colours are rewritten whenever any of them changes.
  useEffect(() => {
    if (meshRef.current) writeComponentMatrices(meshRef.current, batch.ids, entities);
  }, [batch, entities, geometry, surface, capacity]);
  useEffect(() => {
    if (meshRef.current)
      writeBucketColours(meshRef.current, batch.ids, entities, material?.color ?? batch.child.color, selectionSet, tints);
  }, [batch, entities, material, selectionSet, tints, geometry, surface, capacity]);
  useEffect(() => {
    if (displayMode !== 'xray') return;
    surface.opacity = batch.ids.some((id) => selectionSet.has(id)) ? XRAY_OPACITY.selected : XRAY_OPACITY.idle;
    surface.needsUpdate = true;
  }, [displayMode, batch.ids, selectionSet, surface]);

  const handleClick = useMemo(
    () =>
      (event: ThreeEvent<MouseEvent>): void => {
        if (isClippedAway(event.point)) return;
        event.stopPropagation();
        const id = event.instanceId === undefined ? undefined : batch.ids[event.instanceId];
        if (id !== undefined) onSelect(id, isAdditiveSelect(event.nativeEvent));
      },
    [batch.ids, onSelect],
  );

  if (count === 0) return null;
  return <instancedMesh ref={meshRef} args={[geometry, surface, capacity]} count={count} onClick={handleClick} castShadow receiveShadow />;
}

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
