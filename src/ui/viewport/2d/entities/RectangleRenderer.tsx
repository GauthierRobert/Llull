/**
 * @layer ui/viewport/2d
 * Render branch for `kind:'rectangle'`: closed 4-corner loop, lower-left at the entity origin,
 * width along +X and height along +Y.
 */

import { useMemo } from 'react';
import type { RectangleEntity } from '@core/model/types';
import { flattenPoints } from '../../lineGeometry';
import { ShapeLine } from './PlacedLineObject';

export function RectangleRenderer({
  entity: { width, height, position, color },
  selected,
}: {
  entity: RectangleEntity;
  selected: boolean;
}): React.ReactElement {
  const positions = useMemo(
    () =>
      flattenPoints([
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
        [0, 0],
      ]),
    [width, height],
  );
  return <ShapeLine positions={positions} position={position} color={color} selected={selected} />;
}
