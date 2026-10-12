/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'image'` (shared by the 2D and 3D views through Shape2DRenderer): the
 * raster as a textured plane on its work plane, drawn first (`renderOrder` −1) and without depth
 * writes so every shape and solid paints over it; `opacity` from the entity. Not raycast — picking
 * goes through the pure 2D pick helpers, which skip locked underlays. A selected underlay shows its
 * frame in the selection color.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { ImageEntity } from '@core/model/types';
import { closeLoop, flattenPoints, rectangleCorners } from '../../lineGeometry';
import { ShapeLine } from './ShapeLine';
import { underlayPlaneGeometry } from './underlayPlane';

const noRaycast = (): void => undefined;

export function ImageUnderlayRenderer({
  entity: { dataUrl, width, height, opacity, position, rotation, color },
  selected,
}: {
  entity: ImageEntity;
  selected: boolean;
}): React.ReactElement {
  const geometry = useMemo(() => underlayPlaneGeometry(width, height), [width, height]);
  const texture = useMemo(() => {
    const loaded = new THREE.TextureLoader().load(dataUrl);
    loaded.colorSpace = THREE.SRGBColorSpace;
    return loaded;
  }, [dataUrl]);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [texture, opacity],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => texture.dispose(), [texture]);
  useEffect(() => () => material.dispose(), [material]);

  const frame = useMemo(
    () => flattenPoints(closeLoop(rectangleCorners(width, height))),
    [width, height],
  );

  return (
    <group position={position} rotation={[rotation[0], rotation[1], rotation[2]]}>
      <mesh geometry={geometry} material={material} renderOrder={-1} raycast={noRaycast} />
      {selected && <ShapeLine positions={frame} position={[0, 0, 0]} color={color} selected />}
    </group>
  );
}
