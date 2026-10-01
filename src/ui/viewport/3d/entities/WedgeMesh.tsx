/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'wedge'` entities.
 * A right-triangular prism (ramp): full height at the front face (z=0),
 * tapering to zero height at the back face (z=depth).
 * `size` = [width(X), height(Y), depth(Z)].
 * `position` is the lower-front-left corner per the WedgeEntity spec.
 *
 * Custom BufferGeometry with computed normals (r3f R9 — dispose on unmount).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { WedgeEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';
import { buildWedgeGeometry } from './primitiveGeometry';

interface WedgeMeshProps {
  entity: WedgeEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Optional PBR material override from an assigned document material (VNF4). */
  pbrMaterial?: { color: string; metalness: number; roughness: number };
}

export function WedgeMesh({
  entity,
  selected,
  onSelect,
  pbrMaterial,
}: WedgeMeshProps): React.ReactElement {
  const { size, position, rotation, color } = entity;
  const [w, h, d] = size;

  const geometry = useMemo(() => buildWedgeGeometry(w, h, d), [w, h, d]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Build BVH once per geometry for O(log n) raycasting; dispose with the geometry (R9).
  useEffect(() => {
    geometry.computeBoundsTree();
    return () => {
      geometry.disposeBoundsTree();
      geometry.dispose();
    };
  }, [geometry]);

  const matProps = useMaterialProps({
    color,
    selected,
    roughness: 0.5,
    metalness: 0.08,
    envMapIntensity: 0.8,
    ...(pbrMaterial ? { pbrOverride: pbrMaterial } : {}),
  });

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
