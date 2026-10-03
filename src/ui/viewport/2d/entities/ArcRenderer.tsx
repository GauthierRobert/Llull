/** @layer ui/viewport/2d — render branch for `kind:'arc'`. */

import type { ArcEntity } from '@core/model/types';
import { EllipticalCurve } from './EllipticalCurve';

export function ArcRenderer({
  entity: { center, radius, startAngle, endAngle, position, color },
  selected,
}: {
  entity: ArcEntity;
  selected: boolean;
}): React.ReactElement {
  return (
    <EllipticalCurve
      center={center}
      radiusX={radius}
      radiusY={radius}
      startAngle={startAngle}
      endAngle={endAngle}
      position={position}
      color={color}
      selected={selected}
    />
  );
}
