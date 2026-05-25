/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'circle'` entities.
 * Draws a circle outline in the XY plane using EllipseCurve geometry.
 * Geometry is memoized on the entity's center/radius fields; disposed on unmount.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CircleEntity } from '@core/model/types';

interface CircleRendererProps {
  entity: CircleEntity;
  selected: boolean;
}

const CIRCLE_SEGMENTS = 64;

export function CircleRenderer({ entity, selected }: CircleRendererProps): React.ReactElement {
  const { center, radius, position, color } = entity;

  const lineObject = useMemo(() => {
    const curve = new THREE.EllipseCurve(
      center[0], center[1],
      radius, radius,
      0, Math.PI * 2,
      false,
      0,
    );
    const pts = curve.getPoints(CIRCLE_SEGMENTS);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.Line(geo, mat);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], radius, color, selected]);

  useEffect(() => {
    return () => {
      lineObject.geometry.dispose();
      (lineObject.material as THREE.Material).dispose();
    };
  }, [lineObject]);

  lineObject.position.set(position[0], position[1], position[2]);

  return <primitive object={lineObject} />;
}
