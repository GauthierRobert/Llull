/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'sphere'` entities.
 * Geometry is memoized on the entity's geometric fields; disposed on unmount.
 * Material props reflect the active display mode (shaded/wireframe/xray).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { SphereEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';
import { radialSegmentsForDiag, sphereDiag } from '../lodSegments';

interface SphereMeshProps {
  entity: SphereEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Optional PBR material override from an assigned document material (VNF4). */
  pbrMaterial?: { color: string; metalness: number; roughness: number };
}

export function SphereMesh({ entity, selected, onSelect, pbrMaterial }: SphereMeshProps): React.ReactElement {
  const { radius, position, rotation, color } = entity;

  const geometry = useMemo(() => {
    const segments = radialSegmentsForDiag(sphereDiag(radius));
    // heightSegments = half of radialSegments, clamped to [4, 32] for correct normals.
    const heightSeg = Math.max(4, Math.min(32, Math.floor(segments / 2)));
    const geo = new THREE.SphereGeometry(radius, segments, heightSeg);
    return geo;
  }, [radius]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Build BVH once per geometry for O(log n) raycasting; dispose with the geometry (R9).
  useEffect(() => {
    geometry.computeBoundsTree();
    return () => {
      geometry.disposeBoundsTree();
      geometry.dispose();
    };
  }, [geometry]);

  const matProps = useMaterialProps({ color, selected, roughness: 0.35, metalness: 0.12, envMapIntensity: 1.0, ...(pbrMaterial ? { pbrOverride: pbrMaterial } : {}) });

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
