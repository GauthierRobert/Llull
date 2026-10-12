/**
 * @layer ui/viewport/3d
 *
 * Text decals of a solid: each decal's core projection patch (`@core/geometry/decal`, the same
 * triangles and UVs the glTF export writes) textured with the core block-font raster, drawn on top
 * of the solid in its local frame. Geometry and textures are rebuilt only when the entity changes
 * (pure commands give a new reference) and disposed with it (R9).
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Entity } from '@core/model/types';
import { decalPatch } from '@core/geometry/decal';
import { localTriangles } from '@core/geometry/solidTriangles';
import { rasterizeText } from '@core/lib/blockFont';

interface DecalItem {
  readonly id: string;
  readonly geometry: THREE.BufferGeometry;
  readonly texture: THREE.DataTexture;
}

export function DecalOverlay({ entity }: { entity: Entity }): React.ReactElement | null {
  const items = useMemo((): DecalItem[] => {
    if (entity.decals === undefined || entity.decals.length === 0) return [];
    const local = localTriangles(entity);
    return entity.decals.map((decal) => {
      const patch = decalPatch(decal, local);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(patch.positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(patch.uvs, 2));
      geometry.computeVertexNormals();
      const image = rasterizeText(decal.text, decal.color, decal.background);
      const texture = new THREE.DataTexture(
        new Uint8Array(image.rgba),
        image.width,
        image.height,
        THREE.RGBAFormat,
      );
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      return { id: decal.id, geometry, texture };
    });
  }, [entity]);
  useEffect(
    () => () =>
      items.forEach((item) => {
        item.geometry.dispose();
        item.texture.dispose();
      }),
    [items],
  );
  if (items.length === 0) return null;
  const { position, rotation } = entity;
  return (
    <group
      position={[position[0], position[1], position[2]]}
      rotation={[rotation[0], rotation[1], rotation[2]]}
    >
      {items.map((item) => (
        <mesh key={item.id} name={item.id} geometry={item.geometry} renderOrder={1}>
          <meshStandardMaterial
            map={item.texture}
            transparent
            depthWrite={false}
            roughness={0.6}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      ))}
    </group>
  );
}
