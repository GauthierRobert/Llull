/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'cone'` entities.
 * Uses THREE.ConeGeometry — apex at +Y, base centered on position (Y-up, consistent with CylinderMesh).
 * Geometry is memoized on the entity's geometric fields; disposed on unmount.
 * Material props reflect the active display mode (shaded/wireframe/xray).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { ConeEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';
import { radialSegmentsForDiag, cylinderDiag } from '../lodSegments';

interface ConeMeshProps {
  entity: ConeEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Optional PBR material override from an assigned document material (VNF4). */
  pbrMaterial?: { color: string; metalness: number; roughness: number };
}

export function ConeMesh({ entity, selected, onSelect, pbrMaterial }: ConeMeshProps): React.ReactElement {
  const { radius, height, position, rotation, color } = entity;

  const geometry = useMemo(() => {
    const segments = radialSegmentsForDiag(cylinderDiag(radius, height));
    // radiusTop=0, radiusBottom=radius, height, radialSegments — apex along +Y (three.js default).
    const geo = new THREE.ConeGeometry(radius, height, segments);
    return geo;
  }, [radius, height]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Build BVH once per geometry for O(log n) raycasting; dispose with the geometry (R9).
  useEffect(() => {
    geometry.computeBoundsTree();
    return () => {
      geometry.disposeBoundsTree();
      geometry.dispose();
    };
  }, [geometry]);

  const matProps = useMaterialProps({ color, selected, roughness: 0.45, metalness: 0.08, envMapIntensity: 0.8, ...(pbrMaterial ? { pbrOverride: pbrMaterial } : {}) });

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
