/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'pyramid'` entities.
 * Rectangular base centered at position (±baseWidth/2 in X, ±baseDepth/2 in Z),
 * apex at +Y*height (Y-up, consistent with the rest of the 3D viewport).
 *
 * Custom BufferGeometry: 4 triangular side faces + 2 base triangles.
 * Normals computed via computeVertexNormals() for correct lighting.
 * Geometry is memoized on geometric fields; disposed on unmount (r3f R9).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { PyramidEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';

interface PyramidMeshProps {
  entity: PyramidEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

/**
 * Build a rectangular pyramid BufferGeometry centered at the local origin.
 *
 * Base corners (y=0):
 *   v0 = (-hw, 0, -hd)   v1 = ( hw, 0, -hd)
 *   v2 = ( hw, 0,  hd)   v3 = (-hw, 0,  hd)
 * Apex: v4 = (0, height, 0)
 *
 * 6 triangles total: 2 for the base, 4 for the side faces.
 */
function buildPyramidGeometry(baseWidth: number, baseDepth: number, height: number): THREE.BufferGeometry {
  const hw = baseWidth / 2;
  const hd = baseDepth / 2;

  // prettier-ignore
  const vertices = new Float32Array([
    // Base — two triangles (wound clockwise from below = CCW from above)
    -hw, 0, -hd,   hw, 0,  hd,  -hw, 0,  hd,   // tri 0 (v0,v2,v3)
    -hw, 0, -hd,   hw, 0, -hd,   hw, 0,  hd,   // tri 1 (v0,v1,v2)

    // Front side (z = -hd): v0,v1,apex
     hw, 0, -hd,  -hw, 0, -hd,   0, height, 0,

    // Right side (x = +hw): v1,v2,apex
     hw, 0,  hd,   hw, 0, -hd,   0, height, 0,

    // Back side (z = +hd): v2,v3,apex
    -hw, 0,  hd,   hw, 0,  hd,   0, height, 0,

    // Left side (x = -hw): v3,v0,apex
    -hw, 0, -hd,  -hw, 0,  hd,   0, height, 0,
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

export function PyramidMesh({ entity, selected, onSelect }: PyramidMeshProps): React.ReactElement {
  const { baseWidth, baseDepth, height, position, rotation, color } = entity;

  const geometry = useMemo(
    () => buildPyramidGeometry(baseWidth, baseDepth, height),
    [baseWidth, baseDepth, height],
  );

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
