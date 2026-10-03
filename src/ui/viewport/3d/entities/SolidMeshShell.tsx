/**
 * @layer ui/viewport/3d
 *
 * Shared render shell for every 3D solid kind: selection click, display-mode material,
 * BVH raycasting acceleration and geometry disposal (R9). Each kind supplies only its
 * memoized geometry and base surface constants.
 */

import { useEffect } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { BaseEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';

export interface SolidSurface {
  roughness: number;
  metalness: number;
  envMapIntensity: number;
}

/** Default surface used by most solid kinds. */
export const DEFAULT_SOLID_SURFACE: SolidSurface = {
  roughness: 0.45,
  metalness: 0.08,
  envMapIntensity: 0.8,
};

export interface SolidMeshKindProps<E extends BaseEntity> {
  entity: E;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Optional PBR material override from an assigned document material. */
  pbrMaterial?: { color: string; metalness: number; roughness: number };
}

interface SolidMeshShellProps {
  entity: Pick<BaseEntity, 'id' | 'position' | 'rotation' | 'color'>;
  geometry: THREE.BufferGeometry;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  pbrMaterial?: { color: string; metalness: number; roughness: number };
  surface?: SolidSurface;
  /** Render both faces regardless of display mode. */
  doubleSided?: boolean;
  /** Build a BVH for raycasting (default true). */
  boundsTree?: boolean;
}

export function SolidMeshShell({
  entity,
  geometry,
  selected,
  onSelect,
  pbrMaterial,
  surface = DEFAULT_SOLID_SURFACE,
  doubleSided = false,
  boundsTree = true,
}: SolidMeshShellProps): React.ReactElement {
  const { position, rotation, color } = entity;

  // Build BVH once per geometry for O(log n) raycasting; dispose with the geometry (R9).
  useEffect(() => {
    if (boundsTree) geometry.computeBoundsTree();
    else geometry.computeBoundingBox();
    return () => {
      if (boundsTree) geometry.disposeBoundsTree();
      geometry.dispose();
    };
  }, [geometry, boundsTree]);

  const matProps = useMaterialProps({
    color,
    selected,
    ...surface,
    ...(pbrMaterial ? { pbrOverride: pbrMaterial } : {}),
  });

  function handleClick(e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation();
    const additive = e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
    onSelect(entity.id, additive);
  }

  return (
    <mesh
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
        side={doubleSided ? THREE.DoubleSide : matProps.side}
      />
    </mesh>
  );
}
