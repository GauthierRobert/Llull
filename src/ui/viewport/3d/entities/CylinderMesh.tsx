/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'cylinder'` entities.
 * Geometry is memoized on the entity's geometric fields; disposed on unmount.
 * Material props reflect the active display mode (shaded/wireframe/xray).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { CylinderEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';

interface CylinderMeshProps {
  entity: CylinderEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

export function CylinderMesh({ entity, selected, onSelect }: CylinderMeshProps): React.ReactElement {
  const { radius, height, position, rotation, color } = entity;

  const geometry = useMemo(() => {
    // radiusTop, radiusBottom, height, radialSegments
    const geo = new THREE.CylinderGeometry(radius, radius, height, 32);
    return geo;
  }, [radius, height]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Dispose the previous geometry when it changes or the component unmounts (r3f R9).
  useEffect(() => () => geometry.dispose(), [geometry]);

  const matProps = useMaterialProps({ color, selected, roughness: 0.45, metalness: 0.08, envMapIntensity: 0.8 });

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
        color={matProps.color}
        emissive={matProps.emissive}
        emissiveIntensity={matProps.emissiveIntensity}
        roughness={matProps.roughness}
        metalness={matProps.metalness}
        envMapIntensity={matProps.envMapIntensity}
        wireframe={matProps.wireframe}
        transparent={matProps.transparent}
        opacity={matProps.opacity}
        depthWrite={matProps.depthWrite}
        side={matProps.side}
      />
    </mesh>
  );
}
