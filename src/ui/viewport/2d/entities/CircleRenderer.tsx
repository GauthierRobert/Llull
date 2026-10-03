/** @layer ui/viewport/2d — render branch for `kind:'circle'`. */

import type { CircleEntity } from '@core/model/types';
import { EllipticalCurve } from './EllipticalCurve';

export function CircleRenderer({
  entity: { center, radius, position, color },
  selected,
}: {
  entity: CircleEntity;
  selected: boolean;
}): React.ReactElement {
  return (
    <EllipticalCurve
      center={center}
      radiusX={radius}
      radiusY={radius}
      startAngle={0}
      endAngle={Math.PI * 2}
      position={position}
      color={color}
      selected={selected}
    />
  );
}
