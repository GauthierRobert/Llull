// `kind:'image'` (2D + 3D via Shape2DRenderer): textured plane drawn first (renderOrder −1, no depth write) so all
// geometry paints over it; not raycast (pure pick helpers skip locked underlays); selected = frame in selection color.

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { ImageEntity } from '@core/model/types';
import { rectangleOutline } from '../../lineGeometry';
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

  const frame = useMemo(() => rectangleOutline(width, height), [width, height]);

  return (
    <group position={position} rotation={rotation}>
      <mesh geometry={geometry} material={material} renderOrder={-1} raycast={noRaycast} />
      {selected && <ShapeLine positions={frame} position={[0, 0, 0]} color={color} selected />}
    </group>
  );
}
