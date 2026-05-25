/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'extrusion'` entities.
 * Builds a THREE.ExtrudeGeometry from the 2D profile; memoized on profile + depth.
 * Geometry is disposed on unmount (r3f R9).
 * Material props reflect the active display mode (shaded/wireframe/xray).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { ExtrusionEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';

interface ExtrusionMeshProps {
  entity: ExtrusionEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

/** Stable serialization key for the profile array. */
function profileKey(profile: ExtrusionEntity['profile']): string {
  return profile.map(([x, y]) => `${x},${y}`).join(';');
}

export function ExtrusionMesh({ entity, selected, onSelect }: ExtrusionMeshProps): React.ReactElement {
  const { profile, depth, position, rotation, color } = entity;

  // Rebuild geometry only when the profile points or depth change.
  const pKey = profileKey(profile);

  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    if (profile.length === 0) return new THREE.BufferGeometry();

    const first = profile[0];
    if (!first) return new THREE.BufferGeometry();
    shape.moveTo(first[0], first[1]);
    for (let i = 1; i < profile.length; i++) {
      const pt = profile[i];
      if (pt) shape.lineTo(pt[0], pt[1]);
    }
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
    });
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pKey, depth]);

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
      name={entity.id}
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
