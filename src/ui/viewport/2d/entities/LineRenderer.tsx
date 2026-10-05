/** @layer ui/viewport/2d — render branch for `kind:'line'`: one LineSegments segment in the XY plane. */

import { useMemo } from 'react';
import type { LineEntity } from '@core/model/types';
import { ShapeLine } from './PlacedLineObject';

export function LineRenderer({
  entity: { start, end, position, color },
  selected,
}: {
  entity: LineEntity;
  selected: boolean;
}): React.ReactElement {
  const [startX, startY] = start;
  const [endX, endY] = end;
  const positions = useMemo(() => [startX, startY, 0, endX, endY, 0], [startX, startY, endX, endY]);
  return (
    <ShapeLine
      positions={positions}
      segments
      position={position}
      color={color}
      selected={selected}
    />
  );
}
