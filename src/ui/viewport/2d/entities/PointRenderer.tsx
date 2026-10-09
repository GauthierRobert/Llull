/**
 * @layer ui/viewport/2d — render branch for `kind:'point'`: a cross at the entity position whose
 * on-screen size is constant (rescaled per frame), so it stays visible at any model scale.
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import type * as THREE from 'three';
import type { PointEntity } from '@core/model/types';
import { flattenPoints } from '../../lineGeometry';
import { POINT_MARKER_HALF_PIXELS, worldUnitsForPixels } from '../pointMarkerScale';
import { ShapeLine } from './ShapeLine';

const markerWorld = new Vector3();
const ORIGIN: [number, number, number] = [0, 0, 0];
/** Unit half-arm; the group scale turns it into POINT_MARKER_HALF_PIXELS on screen. */
const CROSS_POSITIONS = flattenPoints([
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]);

export function PointRenderer({
  entity: { position, color },
  selected,
}: {
  entity: PointEntity;
  selected: boolean;
}): React.ReactElement {
  const markerRef = useRef<THREE.Group>(null);
  useFrame(({ camera, size }) => {
    const marker = markerRef.current;
    if (!marker) return;
    const scale =
      (camera as THREE.OrthographicCamera).isOrthographicCamera === true
        ? worldUnitsForPixels(POINT_MARKER_HALF_PIXELS, {
            kind: 'orthographic',
            zoom: (camera as THREE.OrthographicCamera).zoom,
          })
        : worldUnitsForPixels(POINT_MARKER_HALF_PIXELS, {
            kind: 'perspective',
            fovDegrees: (camera as THREE.PerspectiveCamera).fov,
            distance: camera.position.distanceTo(marker.getWorldPosition(markerWorld)),
            viewportHeight: size.height,
          });
    if (marker.scale.x !== scale) marker.scale.setScalar(scale);
  });

  return (
    <group ref={markerRef} position={position}>
      <ShapeLine
        positions={CROSS_POSITIONS}
        segments
        linewidth={2}
        position={ORIGIN}
        color={color}
        selected={selected}
      />
    </group>
  );
}
