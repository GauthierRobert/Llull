// One InstancedMesh of an instance array: the members of one LOD tier for one child solid of the prototype component. Matrices are written
// from the packed table into the mesh's own buffer (no per-member object); picking maps the slot back to the member index.

import { useEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type * as THREE from 'three';
import { instanceMemberId } from '@core/model/instanceArray';
import type { Vec3 } from '@core/model/types';
import { isAdditiveSelect } from '../../selectClick';
import { useBatchCapacity } from '../InstancedRenderer';
import { isClippedAway } from '../review/activeClipPlanes';
import { writeMemberMatrices } from './arrayMatrices';
import { memberRaycast } from './arrayPick';

export interface ArrayTierMeshProps {
  arrayId: string;
  tier: 0 | 1 | 2;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  table: Float64Array;
  members: Uint32Array;
  scale: Vec3 | undefined;
  radius: number;
  onPickMember: (memberId: string, additive: boolean) => void;
}

export function ArrayTierMesh({
  arrayId,
  tier,
  geometry,
  material,
  table,
  members,
  scale,
  radius,
  onPickMember,
}: ArrayTierMeshProps): React.ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = members.length;
  const capacity = useBatchCapacity(count);

  // A new `args` makes r3f build a NEW InstancedMesh: the matrices are rewritten whenever any input of it changes.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    writeMemberMatrices(mesh.instanceMatrix.array as Float32Array, table, members, scale);
    mesh.count = members.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [table, members, scale, geometry, material, capacity]);

  const raycast = useMemo(() => memberRaycast(table, members, radius), [table, members, radius]);
  if (count === 0) return null;

  function handleClick(event: ThreeEvent<MouseEvent>): void {
    if (isClippedAway(event.point)) return;
    const index = event.instanceId === undefined ? undefined : members[event.instanceId];
    if (index === undefined) return;
    event.stopPropagation();
    onPickMember(instanceMemberId(arrayId, index), isAdditiveSelect(event.nativeEvent));
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, capacity]}
      count={count}
      userData={{ arrayId, lodTier: tier }}
      onClick={handleClick}
      raycast={raycast}
      frustumCulled={false}
      castShadow={tier === 0}
      receiveShadow={tier === 0}
    />
  );
}
