/**
 * three.js textures of a material finish, built from the same core procedural maps the glTF export
 * embeds (`@core/geometry/finishMaps`), plus the box-projected UV attribute a mesh needs to show
 * them. Textures are memoized per finish and disposed when it changes (R9).
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Material } from '@core/model/types';
import { facetNormal } from '@core/geometry/tessellation';
import { boxUv, finishMaps } from '@core/geometry/finishMaps';

export interface FinishTextures {
  readonly map: THREE.DataTexture;
  readonly normalMap: THREE.DataTexture;
  readonly roughnessMap: THREE.DataTexture;
  readonly normalScale: number;
  readonly clearcoat: number;
}

type FinishSource = Pick<Material, 'color' | 'metalness' | 'roughness' | 'finish'>;

function dataTexture(rgba: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array(rgba), size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Textures of `material`'s finish, or null (no material, no finish). */
export function useFinishTextures(material: FinishSource | undefined): FinishTextures | null {
  const textures = useMemo((): FinishTextures | null => {
    if (material?.finish === undefined) return null;
    const maps = finishMaps(material);
    if (maps === null) return null;
    return {
      map: dataTexture(maps.albedo, maps.size, true),
      normalMap: dataTexture(maps.normal, maps.size, false),
      roughnessMap: dataTexture(maps.metallicRoughness, maps.size, false),
      normalScale: material.finish.normalStrength ?? 1,
      clearcoat: material.finish.clearcoat ?? 0,
    };
  }, [material]);
  useEffect(
    () => () => {
      textures?.map.dispose();
      textures?.normalMap.dispose();
      textures?.roughnessMap.dispose();
    },
    [textures],
  );
  return textures;
}

/**
 * Writes a box-projected `uv` attribute (one tile per `scale` units). A non-indexed triangle soup
 * projects each triangle by its facet normal, exactly like the glTF export (core boxUv); indexed
 * geometry falls back to its vertex normals.
 */
export function applyBoxUvs(geometry: THREE.BufferGeometry, scale: number): void {
  const position = geometry.getAttribute('position');
  const corner = (i: number): [number, number, number] => [position.getX(i), position.getY(i), position.getZ(i)];
  if (geometry.index === null && geometry.getAttribute('normal') === undefined) geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal');
  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const facet =
      geometry.index === null
        ? facetNormal(corner(i - (i % 3)), corner(i - (i % 3) + 1), corner(i - (i % 3) + 2))
        : ([normal.getX(i), normal.getY(i), normal.getZ(i)] as const);
    const uv = boxUv(corner(i), facet, scale);
    uvs[i * 2] = uv[0];
    uvs[i * 2 + 1] = uv[1];
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}
