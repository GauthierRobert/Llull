/** @layer ui/viewport/2d — render branches for `kind:'circle' | 'arc' | 'ellipse'`. */

import type { ArcEntity, CircleEntity, EllipseEntity } from '@core/model/types';
import { EllipticalCurve } from './EllipticalCurve';

type Branch<E> = { entity: E; selected: boolean };

const FULL_TURN = { startAngle: 0, endAngle: Math.PI * 2 };

export function CircleRenderer({
  entity: { center, radius, position, rotation, color },
  selected,
}: Branch<CircleEntity>): React.ReactElement {
  const shared = { center, position, rotation, color, selected };
  return <EllipticalCurve {...shared} {...FULL_TURN} radiusX={radius} radiusY={radius} />;
}

export function ArcRenderer({
  entity: { center, radius, startAngle, endAngle, position, rotation, color },
  selected,
}: Branch<ArcEntity>): React.ReactElement {
  const shared = { center, position, rotation, color, selected };
  return (
    <EllipticalCurve
      {...shared}
      startAngle={startAngle}
      endAngle={endAngle}
      radiusX={radius}
      radiusY={radius}
    />
  );
}

export function EllipseRenderer({
  entity: { center, radiusX, radiusY, position, rotation, color },
  selected,
}: Branch<EllipseEntity>): React.ReactElement {
  const shared = { center, position, rotation, color, selected };
  return <EllipticalCurve {...shared} {...FULL_TURN} radiusX={radiusX} radiusY={radiusY} />;
}
