/** @layer ui/viewport/2d — render branch for `kind:'ellipse'`. */

import type { EllipseEntity } from '@core/model/types';
import { EllipticalCurve } from './EllipticalCurve';

export function EllipseRenderer({
  entity: { center, radiusX, radiusY, position, rotation, color },
  selected,
}: {
  entity: EllipseEntity;
  selected: boolean;
}): React.ReactElement {
  return (
    <EllipticalCurve
      center={center}
      radiusX={radiusX}
      radiusY={radiusY}
      startAngle={0}
      endAngle={Math.PI * 2}
      position={position}
      rotation={rotation}
      color={color}
      selected={selected}
    />
  );
}
