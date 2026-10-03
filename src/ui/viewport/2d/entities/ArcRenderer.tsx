/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'arc'` entities.
 * Draws a circular arc in the XY plane using EllipseCurve geometry.
 * Geometry is memoized on the entity's center/radius/angles; disposed on unmount.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { ArcEntity } from '@core/model/types';
import { PlacedLineObject } from './PlacedLineObject';

interface ArcRendererProps {
  entity: ArcEntity;
  selected: boolean;
}

const ARC_SEGMENTS = 64;

export function ArcRenderer({ entity, selected }: ArcRendererProps): React.ReactElement | null {
  const { center, radius, startAngle, endAngle, position, color } = entity;

  const lineObject = useMemo(() => {
    const curve = new THREE.EllipseCurve(
      center[0],
      center[1],
      radius,
      radius,
      startAngle,
      endAngle,
      false,
      0,
    );
    const pts = curve.getPoints(ARC_SEGMENTS);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.Line(geo, mat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], radius, startAngle, endAngle, color, selected]);

  return <PlacedLineObject object={lineObject} position={position} />;
}
