/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'rectangle'` entities.
 * Draws a 4-corner closed loop in the XY plane.
 * Origin is at the lower-left corner; width extends along +X, height along +Y.
 * Geometry is memoized on the entity's width/height fields; disposed on unmount.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { RectangleEntity } from '@core/model/types';

interface RectangleRendererProps {
  entity: RectangleEntity;
  selected: boolean;
}

export function RectangleRenderer({ entity, selected }: RectangleRendererProps): React.ReactElement {
  const { width, height, position, color } = entity;

  const lineObject = useMemo(() => {
    // Lower-left origin; 5 points to close the loop.
    const vertices = new Float32Array([
      0,     0,      0,
      width, 0,      0,
      width, height, 0,
      0,     height, 0,
      0,     0,      0,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.Line(geo, mat);
  }, [width, height, color, selected]);

  useEffect(() => {
    return () => {
      lineObject.geometry.dispose();
      (lineObject.material as THREE.Material).dispose();
    };
  }, [lineObject]);

  lineObject.position.set(position[0], position[1], position[2]);

  return <primitive object={lineObject} />;
}
