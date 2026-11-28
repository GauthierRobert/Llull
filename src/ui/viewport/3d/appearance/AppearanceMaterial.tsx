// The three.js material of a solid with an appearance: MeshPhysicalMaterial from a `SurfacePlan` and the loaded image maps.
// Channels: base colour (value tint x map), metalness / roughness (value x map), tangent-space normal, emission, transmission + ior
// (glass), clearcoat. Shaded display mode only; the caller keeps the plain material for wireframe / x-ray / ghost / tint.

import { useMemo } from 'react';
import * as THREE from 'three';
import { displayMetalness } from '../displayMetalness';
import type { AppearanceMaps } from './useAppearanceMaps';
import type { SurfacePlan } from './surfacePlan';

interface AppearanceMaterialProps {
  plan: SurfacePlan;
  maps: AppearanceMaps;
  /** Selection highlight: replaces the emission while selected. */
  selectionEmissive?: { readonly color: string; readonly intensity: number } | undefined;
  /** Refraction depth of glass, document units (a fraction of the solid's size). */
  thickness: number;
  side: THREE.Side;
}

export function AppearanceMaterial({ plan, maps, selectionEmissive, thickness, side }: AppearanceMaterialProps): React.ReactElement {
  const normalScale = useMemo(() => new THREE.Vector2(plan.normalScale, plan.normalScale), [plan.normalScale]);
  const emissive = selectionEmissive?.color ?? plan.emissive;
  const emissiveIntensity = selectionEmissive?.intensity ?? plan.emissiveIntensity;
  // A map appearing or going away changes the shader program: a fresh material, as the ghost / solid switch does.
  const programKey = Object.keys(maps).sort().join(',') + (plan.transmission > 0 ? '|glass' : '') + (plan.clearcoat > 0 ? '|coat' : '');
  return (
    <meshPhysicalMaterial
      key={programKey}
      color={plan.color}
      metalness={displayMetalness(plan.metalness)}
      roughness={plan.roughness}
      emissive={emissive}
      emissiveIntensity={emissiveIntensity}
      transmission={plan.transmission}
      ior={plan.ior}
      thickness={plan.transmission > 0 ? thickness : 0}
      clearcoat={plan.clearcoat}
      clearcoatRoughness={plan.clearcoatRoughness}
      envMapIntensity={1}
      side={side}
      polygonOffset
      polygonOffsetFactor={1}
      polygonOffsetUnits={1}
      {...(maps.baseColor !== undefined && { map: maps.baseColor })}
      {...(maps.metalness !== undefined && { metalnessMap: maps.metalness })}
      {...(maps.roughness !== undefined && { roughnessMap: maps.roughness })}
      {...(maps.normal !== undefined && { normalMap: maps.normal, normalScale })}
      {...(maps.emission !== undefined && { emissiveMap: maps.emission })}
      {...(maps.transmission !== undefined && { transmissionMap: maps.transmission })}
      {...(maps.coat !== undefined && { clearcoatMap: maps.coat })}
    />
  );
}
