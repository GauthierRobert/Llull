/**
 * @layer ui/viewport/2d
 *
 * Shared body of the circle / arc / ellipse render branches: an EllipseCurve outline in the
 * entity's XY plane, memoized on its inputs and disposed by PlacedLineObject.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec2, Vec3 } from '@core/model/types';
import { PlacedLineObject } from './PlacedLineObject';

const CURVE_SEGMENTS = 64;

interface EllipticalCurveProps {
  center: Vec2;
  radiusX: number;
  radiusY: number;
  startAngle: number;
  endAngle: number;
  position: Vec3;
  color: string;
  selected: boolean;
}

export function EllipticalCurve({
  center,
  radiusX,
  radiusY,
  startAngle,
  endAngle,
  position,
  color,
  selected,
}: EllipticalCurveProps): React.ReactElement {
  const [centerX, centerY] = center;
  const lineObject = useMemo(() => {
    const curve = new THREE.EllipseCurve(
      centerX,
      centerY,
      radiusX,
      radiusY,
      startAngle,
      endAngle,
      false,
      0,
    );
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(CURVE_SEGMENTS));
    const mat = new THREE.LineBasicMaterial({ color: selected ? '#5b8dee' : color });
    return new THREE.Line(geo, mat);
  }, [centerX, centerY, radiusX, radiusY, startAngle, endAngle, color, selected]);

  return <PlacedLineObject object={lineObject} position={position} />;
}
