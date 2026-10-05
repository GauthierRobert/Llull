/** @layer ui/viewport/2d — render branch for `kind:'polyline'`: open or closed vertex chain. */

import { useMemo } from 'react';
import type { PolylineEntity } from '@core/model/types';
import { flattenPoints } from '../../lineGeometry';
import { ShapeLine } from './PlacedLineObject';

export function PolylineRenderer({
  entity: { points, closed, position, color },
  selected,
}: {
  entity: PolylineEntity;
  selected: boolean;
}): React.ReactElement | null {
  // `points` is a fresh array only when the polyline actually changes (commands are pure, L3),
  // so the reference is a correct + cheap memo key — no serialization.
  const positions = useMemo(() => {
    const [first] = points;
    if (!first || points.length < 2) return null;
    return flattenPoints(closed ? [...points, first] : points);
  }, [points, closed]);

  if (!positions) return null;
  return <ShapeLine positions={positions} position={position} color={color} selected={selected} />;
}
