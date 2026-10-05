/** @layer ui/viewport/2d — render branch for `kind:'point'`: a small cross at the entity position. */

import type { PointEntity } from '@core/model/types';
import { flattenPoints } from '../../lineGeometry';
import { ShapeLine } from './ShapeLine';

const CROSS_SIZE = 0.1;
/** Horizontal arm, then vertical arm — two independent segments. */
const CROSS_POSITIONS = flattenPoints([
  [-CROSS_SIZE, 0],
  [CROSS_SIZE, 0],
  [0, -CROSS_SIZE],
  [0, CROSS_SIZE],
]);

export function PointRenderer({
  entity: { position, color },
  selected,
}: {
  entity: PointEntity;
  selected: boolean;
}): React.ReactElement {
  return (
    <ShapeLine
      positions={CROSS_POSITIONS}
      segments
      linewidth={2}
      position={position}
      color={color}
      selected={selected}
    />
  );
}
