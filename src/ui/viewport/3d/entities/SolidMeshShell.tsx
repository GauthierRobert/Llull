// Shared shell of every 3D solid branch: selection click, display-mode material, BVH raycasting, disposal (R9).

import { useEffect, useLayoutEffect } from 'react';
import * as THREE from 'three';
import type { BaseEntity } from '@core/model/types';
import { selectOnClick } from '@ui/viewport/selectClick';
import { displayMetalness } from '../displayMetalness';
import { useMaterialProps, type PbrMaterial } from '../useMaterialProps';
import { applyBoxUvs, useFinishTextures } from '../useFinishTextures';
import { useViewportStore } from '@ui/store';

export interface SolidSurface {
  roughness: number;
  metalness: number;
  envMapIntensity: number;
}

const DEFAULT_SOLID_SURFACE: SolidSurface = { roughness: 0.45, metalness: 0.08, envMapIntensity: 0.8 };

export interface SolidMeshKindProps<E extends BaseEntity> {
  entity: E;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** From an assigned document material. */
  pbrMaterial?: PbrMaterial | undefined;
}

interface SolidMeshShellProps {
  entity: Pick<BaseEntity, 'id' | 'position' | 'rotation' | 'color'>;
  geometry: THREE.BufferGeometry;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  pbrMaterial?: PbrMaterial | undefined;
  surface?: SolidSurface;
  /** Both faces whatever the display mode. */
  doubleSided?: boolean;
  /** BVH for raycasting (default true). */
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

  // O(log n) raycasts; freed with the geometry.
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
  // Finish maps need UVs: box-projected per geometry / tile size, before the frame draws.
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
      {/* Pushed back so lines drawn on the surface (contours, outlines) stay visible. */}
      {textured ? (
        <meshPhysicalMaterial
          {...matProps}
          color="#ffffff"
          roughness={1}
          metalness={displayMetalness(1)}
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
