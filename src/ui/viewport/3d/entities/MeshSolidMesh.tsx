/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'mesh'` entities — boolean-operation results stored as
 * arbitrary triangle meshes. `MeshSolidEntity.mesh` holds world-space geometry;
 * `position` and `rotation` are [0,0,0] for results produced by the boolean commands,
 * but are honored here so the entity remains gizmo-transformable (TransformControls).
 *
 * Geometry lifecycle:
 *   - Built in `useMemo` keyed on the mesh data reference — rebuilt only when the
 *     mesh itself changes (rare; booleans produce new entities).
 *   - Disposed via `useEffect` cleanup (r3f R9).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { MeshSolidEntity } from '@core/model/types';

interface MeshSolidMeshProps {
  entity: MeshSolidEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

export function MeshSolidMesh({
  entity,
  selected,
  onSelect,
}: MeshSolidMeshProps): React.ReactElement {
  const { mesh, position, rotation, color } = entity;

  // Key on the mesh object reference — mesh data only changes when the entity is
  // replaced by a new boolean command result, so the ref changing is the right signal.
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    // positions: flat xyz triples (Float32Array, 3 values per vertex)
    const posAttr = new THREE.BufferAttribute(new Float32Array(mesh.positions), 3);
    geo.setAttribute('position', posAttr);

    // indices: flat triangle vertex indices (Uint32Array, 3 per triangle)
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));

    // Compute normals from geometry for correct lighting (mesh has no normals stored).
    geo.computeVertexNormals();

    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Dispose geometry when it changes or the component unmounts (r3f R9).
  useEffect(() => () => geometry.dispose(), [geometry]);

  const emissive = selected ? '#3a7bd5' : '#000000';
  const emissiveIntensity = selected ? 0.35 : 0;

  function handleClick(e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation();
    const additive = e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
    onSelect(entity.id, additive);
  }

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      position={[position[0], position[1], position[2]]}
      rotation={[rotation[0], rotation[1], rotation[2]]}
      onClick={handleClick}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        roughness={0.5}
        metalness={0.15}
        envMapIntensity={0.8}
      />
    </mesh>
  );
}
