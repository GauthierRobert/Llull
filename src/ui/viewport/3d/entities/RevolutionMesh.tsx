/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'revolution'` entities.
 *
 * Builds a THREE.LatheGeometry from `entity.profile` (an array of [radial, axial]
 * points), rotating through `entity.angle` radians with `entity.segments` subdivisions.
 *
 * LatheGeometry rotates a profile around the +Y axis by default. The axis alignment
 * quaternion rotates that +Y sweep axis to match `entity.axis`:
 *   - [0,1,0] → Y-axis revolution (no rotation needed — LatheGeometry default).
 *   - [0,0,1] → Z-axis revolution (the doc Z-up default; axis is rotated from Y→Z).
 *   - [1,0,0] → X-axis revolution.
 *   - arbitrary Vec3 → setFromUnitVectors(Y, axisNorm).
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

interface RevolutionMeshProps {
  entity: RevolutionEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Optional PBR material override from an assigned document material (VNF4). */
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

/**
 * Build a THREE.Quaternion that rotates the LatheGeometry's default sweep axis (+Y)
 * to align with the given axis direction.
 */
function axisRotation(axis: RevolutionEntity['axis']): THREE.Quaternion {
  const ax = axis[0];
  const ay = axis[1];
  const az = axis[2];
  const axisVec = new THREE.Vector3(ax, ay, az);
  const len = axisVec.length();
  if (len < 1e-10) return new THREE.Quaternion(); // degenerate axis — identity

  axisVec.divideScalar(len); // normalize in place
  const yAxis = new THREE.Vector3(0, 1, 0);

  // If axis is already +Y, no rotation is needed.
  if (axisVec.dot(yAxis) > 1 - 1e-8) return new THREE.Quaternion();
  // If axis is -Y, flip 180° around X.
  if (axisVec.dot(yAxis) < -1 + 1e-8) {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  }

  return new THREE.Quaternion().setFromUnitVectors(yAxis, axisVec);
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

  /**
   * Build LatheGeometry from the profile.
   *
   * LatheGeometry expects an array of Vector2 points that define the profile in
   * the XY half-plane (X = radial distance from Y-axis, Y = axial height along Y-axis).
   * Entity profile is [radialOffset, axialOffset], which maps directly to [x, y].
   *
   * Memoized on profile points, axis, angle, and segments.
   */
  const geometry = useMemo(() => {
    if (profile.length < 2) return new THREE.BufferGeometry();

    const points = profile.map(([r, a]) => new THREE.Vector2(Math.max(0, r), a));
    const geo = new THREE.LatheGeometry(points, segments, 0, angle);
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pKey, aKey, angle, segments]);

  // Dispose geometry on unmount / geometry change (R9).
  useEffect(() => {
    geometry.computeBoundingBox();
    return () => {
      geometry.dispose();
    };
  }, [geometry]);

  // Compute the quaternion that maps LatheGeometry's +Y sweep axis to entity.axis.
  // Memoized on axis only — does not depend on angle or profile.
  const axisQuat = useMemo(() => axisRotation(axis), [aKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Combine axis alignment quaternion with entity's own Euler rotation.
  const combinedRotation = useMemo(() => {
    const entityEuler = new THREE.Euler(rotation[0], rotation[1], rotation[2], 'XYZ');
    const entityQuat = new THREE.Quaternion().setFromEuler(entityEuler);
    const combined = axisQuat.clone().multiply(entityQuat);
    return new THREE.Euler().setFromQuaternion(combined, 'XYZ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aKey, rotation[0], rotation[1], rotation[2]]);

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

  if (profile.length < 2) return null;

  return (
    <mesh
      ref={meshRef}
      name={entity.id}
      geometry={geometry}
      position={[position[0], position[1], position[2]]}
      rotation={[combinedRotation.x, combinedRotation.y, combinedRotation.z]}
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
