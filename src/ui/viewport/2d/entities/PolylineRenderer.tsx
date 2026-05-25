/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'polyline'` entities.
 * Draws connected line segments (open) or a closed loop in the XY plane.
 * Geometry is memoized on the entity's points/closed fields; disposed on unmount.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { PolylineEntity } from '@core/model/types';

interface PolylineRendererProps {
  entity: PolylineEntity;
  selected: boolean;
}

export function PolylineRenderer({ entity, selected }: PolylineRendererProps): React.ReactElement | null {
  const { points, closed, position, color } = entity;

  const lineObject = useMemo(() => {
    if (points.length < 2) return null;

    const pts = closed ? [...points, points[0]] : points;
    const vertices = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      vertices[i * 3]     = pts[i]![0];
      vertices[i * 3 + 1] = pts[i]![1];
      vertices[i * 3 + 2] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.Line(geo, mat);
    // `points` is a fresh array only when the polyline actually changes (commands are
    // pure, L3), so the reference is a correct + cheap memo key — no serialization.
  }, [points, closed, color, selected]);

  useEffect(() => {
    return () => {
      lineObject?.geometry.dispose();
      (lineObject?.material as THREE.Material | undefined)?.dispose();
    };
  }, [lineObject]);

  if (!lineObject) return null;

  lineObject.position.set(position[0], position[1], position[2]);

  return <primitive object={lineObject} />;
}
