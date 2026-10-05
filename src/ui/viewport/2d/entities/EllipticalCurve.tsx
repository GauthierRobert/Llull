/**
 * @layer ui/viewport/2d
 *
 * Shared body of the circle / arc / ellipse render branches: an EllipseCurve outline in the
 * entity's XY plane, memoized on its inputs.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec2, Vec3 } from '@core/model/types';
import { ShapeLine } from './ShapeLine';

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
  const positions = useMemo(() => {
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
    return curve.getPoints(CURVE_SEGMENTS).flatMap(({ x, y }) => [x, y, 0]);
  }, [centerX, centerY, radiusX, radiusY, startAngle, endAngle]);

  return <ShapeLine positions={positions} position={position} color={color} selected={selected} />;
}
