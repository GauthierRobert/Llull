/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'box'` entities.
 * Geometry is memoized on the entity's size fields; disposed on unmount.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { BoxEntity } from '@core/model/types';

interface BoxMeshProps {
  entity: BoxEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

export function BoxMesh({ entity, selected, onSelect }: BoxMeshProps): React.ReactElement {
  const { size, position, rotation, color } = entity;

  const [sx, sy, sz] = size;

  const geometry = useMemo(() => {
    return new THREE.BoxGeometry(sx, sy, sz);
  }, [sx, sy, sz]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Dispose the previous geometry when it changes or the component unmounts (r3f R9).
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
    >
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        roughness={0.55}
        metalness={0.1}
      />
    </mesh>
  );
}
