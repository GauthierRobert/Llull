/**
 * Render branch for `kind:'rectangle'`: closed 4-corner loop, lower-left at the entity origin,
 * width along +X and height along +Y.
 */

import { useMemo } from 'react';
import type { RectangleEntity } from '@core/model/types';
import { rectangleOutline } from '../../lineGeometry';
import { ShapeLine } from './ShapeLine';

export function RectangleRenderer({
  entity: { width, height, position, rotation, color },
  selected,
}: {
  entity: RectangleEntity;
  selected: boolean;
}): React.ReactElement {
  const positions = useMemo(() => rectangleOutline(width, height), [width, height]);
  return <ShapeLine positions={positions} position={position} rotation={rotation} color={color} selected={selected} />;
}
