/**
 * @layer ui/viewport/2d
 * Render branch for `kind:'spline'`: centripetal Catmull-Rom curve through the entity's points.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { SplineEntity } from '@core/model/types';
import { ShapeLine } from './PlacedLineObject';

const SPLINE_SEGMENTS_PER_POINT = 16;

export function SplineRenderer({
  entity: { points, closed, position, color },
  selected,
}: {
  entity: SplineEntity;
  selected: boolean;
}): React.ReactElement | null {
  // `points` is a new reference only when the spline actually changes (pure commands, L3).
  const positions = useMemo(() => {
    if (points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(
      points.map(([x, y]) => new THREE.Vector3(x, y, 0)),
      closed,
      'centripetal',
    );
    return curve
      .getPoints(points.length * SPLINE_SEGMENTS_PER_POINT)
      .flatMap(({ x, y, z }) => [x, y, z]);
  }, [points, closed]);

  if (!positions) return null;
  return <ShapeLine positions={positions} position={position} color={color} selected={selected} />;
}
