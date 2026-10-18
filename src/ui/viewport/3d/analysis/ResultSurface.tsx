// The solved result painted on the model: a banded blue -> red mesh (the plot's 12-band scale, crisp bands via a nearest-filtered ramp
// texture sampled by the field value) over the analysed parts, deformed as plotted.

import React from 'react';
import * as THREE from 'three';
import { resultColor } from '@lib/isoBands';
import type { SurfaceView } from '@ui/panels/analysis/surfaceData';
import { useDisposable } from '../../useDisposable';

/** One texel per band; nearest filtering keeps the band edges crisp. */
function rampTexture(bands: number): THREE.DataTexture {
  const data = new Uint8Array(bands * 4);
  for (let band = 0; band < bands; band += 1) {
    const color = new THREE.Color(resultColor((band + 0.5) / bands));
    data.set([Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255), 255], band * 4);
  }
  const texture = new THREE.DataTexture(data, bands, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function surfaceGeometry(surface: SurfaceView): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const low = surface.levels[0] ?? 0;
  const span = (surface.levels.at(-1) ?? 1) - low;
  const uv = new Float32Array(surface.values.length * 2);
  surface.values.forEach((value, index) => {
    uv[index * 2] = span > 0 ? Math.min(1, Math.max(0, (value - low) / span)) : 0.5;
    uv[index * 2 + 1] = 0.5;
  });
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  return geometry;
}

export function ResultSurface({ surface }: { surface: SurfaceView }): React.ReactElement {
  const bands = surface.levels.length - 1;
  const geometry = useDisposable(() => surfaceGeometry(surface), [surface]);
  const ramp = useDisposable(() => rampTexture(bands), [bands]);
  const material = useDisposable(
    () =>
      new THREE.MeshLambertMaterial({
        map: ramp,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [ramp],
  );
  return <mesh name="analysis-result-surface" geometry={geometry} material={material} renderOrder={5} frustumCulled={false} />;
}
