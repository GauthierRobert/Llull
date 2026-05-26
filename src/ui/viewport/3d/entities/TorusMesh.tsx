/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'torus'` entities.
 * Uses THREE.TorusGeometry — torus ring lies in the XY plane (hole faces +Z),
 * centered on position. Consistent with the Y-up viewport convention.
 * Geometry is memoized on the entity's geometric fields; disposed on unmount.
 * Material props reflect the active display mode (shaded/wireframe/xray).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { TorusEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';

interface TorusMeshProps {
  entity: TorusEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

export function TorusMesh({ entity, selected, onSelect }: TorusMeshProps): React.ReactElement {
  const { ringRadius, tubeRadius, position, rotation, color } = entity;

  const geometry = useMemo(() => {
    // TorusGeometry(radius, tube, radialSegments, tubularSegments)
    const geo = new THREE.TorusGeometry(ringRadius, tubeRadius, 20, 48);
    return geo;
  }, [ringRadius, tubeRadius]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Build BVH once per geometry for O(log n) raycasting; dispose with the geometry (R9).
  useEffect(() => {
    geometry.computeBoundsTree();
    return () => {
      geometry.disposeBoundsTree();
      geometry.dispose();
    };
  }, [geometry]);

  const matProps = useMaterialProps({ color, selected, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.9 });

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
