/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'point'` entities.
 * Draws a small cross marker at the entity's position in the XY plane.
 * Geometry is memoized; disposed on unmount.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { PointEntity } from '@core/model/types';

interface PointRendererProps {
  entity: PointEntity;
  selected: boolean;
}

const CROSS_SIZE = 0.1;

export function PointRenderer({ entity, selected }: PointRendererProps): React.ReactElement {
  const { position, color } = entity;

  const segmentsObject = useMemo(() => {
    // A small cross: horizontal + vertical arm drawn as two line segments.
    const s = CROSS_SIZE;
    const vertices = new Float32Array([
      -s,  0, 0,   s,  0, 0,   // horizontal arm
       0, -s, 0,   0,  s, 0,   // vertical arm
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color, linewidth: 2 });
    return new THREE.LineSegments(geo, mat);
  }, [color, selected]);

  useEffect(() => {
    return () => {
      segmentsObject.geometry.dispose();
      (segmentsObject.material as THREE.Material).dispose();
    };
  }, [segmentsObject]);

  segmentsObject.position.set(position[0], position[1], position[2]);

  return <primitive object={segmentsObject} />;
}
