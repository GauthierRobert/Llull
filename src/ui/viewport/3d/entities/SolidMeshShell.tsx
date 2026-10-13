/**
 * Shared render shell for every 3D solid kind: selection click, display-mode material,
 * BVH raycasting acceleration and geometry disposal (R9). Each kind supplies only its
 * memoized geometry and base surface constants.
 */

import { useEffect, useLayoutEffect } from 'react';
import * as THREE from 'three';
import type { BaseEntity } from '@core/model/types';
import { selectOnClick } from '@ui/viewport/selectClick';
import { useMaterialProps, type PbrMaterial } from '../useMaterialProps';
import { applyBoxUvs, useFinishTextures } from '../useFinishTextures';
import { useViewportStore } from '@ui/store';

export interface SolidSurface {
  roughness: number;
  metalness: number;
  envMapIntensity: number;
}

/** Default surface used by most solid kinds. */
const DEFAULT_SOLID_SURFACE: SolidSurface = {
  roughness: 0.45,
  metalness: 0.08,
  envMapIntensity: 0.8,
};

export interface SolidMeshKindProps<E extends BaseEntity> {
  entity: E;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** Optional PBR material override from an assigned document material. */
  pbrMaterial?: PbrMaterial | undefined;
}

interface SolidMeshShellProps {
  entity: Pick<BaseEntity, 'id' | 'position' | 'rotation' | 'color'>;
  geometry: THREE.BufferGeometry;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  pbrMaterial?: PbrMaterial | undefined;
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

  const matProps = useMaterialProps({ color, selected, ...surface, pbrOverride: pbrMaterial });
  const displayMode = useViewportStore((s) => s.displayMode);
  const finishScale = pbrMaterial?.finish?.scale;
  const textures = useFinishTextures(pbrMaterial);
  // The finish maps need UVs: box-projected once per geometry / tile size, before the frame draws.
  useLayoutEffect(() => {
    if (finishScale !== undefined) applyBoxUvs(geometry, finishScale);
  }, [geometry, finishScale]);
  const textured = textures !== null && displayMode === 'shaded';

  return (
    <mesh
      name={entity.id}
      geometry={geometry}
      position={position}
      rotation={rotation}
      onClick={selectOnClick(entity.id, onSelect)}
      castShadow
      receiveShadow
    >
      {/* Pushed back slightly so lines drawn on the surface (contours, outlines) stay visible. */}
      {textured ? (
        <meshPhysicalMaterial
          {...matProps}
          color="#ffffff"
          roughness={1}
          metalness={1}
          map={textures.map}
          normalMap={textures.normalMap}
          normalScale={new THREE.Vector2(textures.normalScale, textures.normalScale)}
          roughnessMap={textures.roughnessMap}
          metalnessMap={textures.roughnessMap}
          clearcoat={textures.clearcoat}
          clearcoatRoughness={0.04}
          side={doubleSided ? THREE.DoubleSide : matProps.side}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      ) : (
        <meshStandardMaterial
          {...matProps}
          side={doubleSided ? THREE.DoubleSide : matProps.side}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      )}
    </mesh>
  );
}
