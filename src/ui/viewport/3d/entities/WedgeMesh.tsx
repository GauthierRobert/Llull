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

interface WedgeMeshProps {
  entity: WedgeEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

/**
 * Build a right-triangular prism BufferGeometry.
 *
 * Vertices (local coords, position=lower-front-left corner):
 *   Front face (z=0): v0=(0,0,0), v1=(w,0,0), v2=(0,h,0), v3=(w,h,0)
 *   Back edge (z=d):  v4=(0,0,d), v5=(w,0,d)
 *
 * 5 faces total: bottom, front, left slope-top, right slope-top, back (actually
 * the sloped top face) and two triangular side faces (left/right).
 *
 * Triangles (wound counter-clockwise from outside):
 *   Bottom   : v0,v5,v4  v0,v1,v5
 *   Front    : v0,v2,v3  v0,v3,v1
 *   Left side: v0,v4,v2
 *   Right side: v1,v3,v5
 *   Slope top: v2,v4,v5  v2,v5,v3
 *
 * Using computeVertexNormals() for correct smooth-ish lighting.
 */
function buildWedgeGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  // prettier-ignore
  const vertices = new Float32Array([
    // Bottom face — two triangles
    0, 0, 0,   w, 0, d,   0, 0, d,   // tri 0 (v0,v5,v4)
    0, 0, 0,   w, 0, 0,   w, 0, d,   // tri 1 (v0,v1,v5)

    // Front face (z=0) — one quad = two triangles
    0, 0, 0,   0, h, 0,   w, h, 0,   // tri 2 (v0,v2,v3)
    0, 0, 0,   w, h, 0,   w, 0, 0,   // tri 3 (v0,v3,v1)

    // Left triangular side (x=0)
    0, 0, 0,   0, 0, d,   0, h, 0,   // tri 4 (v0,v4,v2)

    // Right triangular side (x=w)
    w, 0, 0,   w, h, 0,   w, 0, d,   // tri 5 (v1,v3,v5)

    // Sloped top face — one quad = two triangles
    0, h, 0,   0, 0, d,   w, 0, d,   // tri 6 (v2,v4,v5)
    0, h, 0,   w, 0, d,   w, h, 0,   // tri 7 (v2,v5,v3)  — v3=(w,h,0) but slope meets at (w,0,d)
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

export function WedgeMesh({ entity, selected, onSelect }: WedgeMeshProps): React.ReactElement {
  const { size, position, rotation, color } = entity;
  const [w, h, d] = size;

  const geometry = useMemo(() => buildWedgeGeometry(w, h, d), [w, h, d]);

  const meshRef = useRef<THREE.Mesh>(null);

  // Dispose the previous geometry when it changes or the component unmounts (r3f R9).
  useEffect(() => () => geometry.dispose(), [geometry]);

  const matProps = useMaterialProps({ color, selected, roughness: 0.5, metalness: 0.08, envMapIntensity: 0.8 });

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
