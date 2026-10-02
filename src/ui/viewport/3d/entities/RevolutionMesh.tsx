/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'revolution'` entities.
 *
 * Builds geometry with buildRevolutionGeometry (primitiveGeometry.ts), which uses the same
 * sweep convention as core tessellation/export (start +X, counter-clockwise, dominant-axis frame).
 *
 * Geometry is memoized on (profileKey, axis, angle, segments); disposed on unmount.
 * Material props reflect the active display mode (shaded/wireframe/xray) (R9).
 *
 * @see RevolutionEntity in core/model/types.ts
 * @see tessellateRevolution in core/commands/render.ts (reference tessellation)
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { RevolutionEntity } from '@core/model/types';
import { useMaterialProps } from '../useMaterialProps';
import { buildRevolutionGeometry } from './primitiveGeometry';

interface RevolutionMeshProps {
  entity: RevolutionEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Optional PBR material override from an assigned document material. */
  pbrMaterial?: { color: string; metalness: number; roughness: number };
}

/** Stable string key for the profile array (used as useMemo dep). */
function profileKey(profile: RevolutionEntity['profile']): string {
  return profile.map(([r, a]) => `${r},${a}`).join(';');
}

/** Stable string key for a Vec3 axis (used as useMemo dep). */
function axisKey(axis: RevolutionEntity['axis']): string {
  return `${axis[0]},${axis[1]},${axis[2]}`;
}

export function RevolutionMesh({
  entity,
  selected,
  onSelect,
  pbrMaterial,
}: RevolutionMeshProps): React.ReactElement | null {
  const { profile, axis, angle, segments, position, rotation, color } = entity;

  const pKey = profileKey(profile);
  const aKey = axisKey(axis);

  const geometry = useMemo(
    () => buildRevolutionGeometry(profile, axis, angle, segments),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pKey, aKey, angle, segments],
  );

  // Dispose geometry on unmount / geometry change (R9).
  useEffect(() => {
    geometry.computeBoundingBox();
    return () => {
      geometry.dispose();
    };
  }, [geometry]);

  const matProps = useMaterialProps({
    color,
    selected,
    roughness: 0.45,
    metalness: 0.08,
    envMapIntensity: 0.8,
    ...(pbrMaterial ? { pbrOverride: pbrMaterial } : {}),
  });

  const meshRef = useRef<THREE.Mesh>(null);

  function handleClick(e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation();
    const additive = e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
    onSelect(entity.id, additive);
  }

  if (profile.length < 3) return null;

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
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
