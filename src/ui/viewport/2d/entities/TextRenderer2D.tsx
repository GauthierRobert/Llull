/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'text'` entities in the 2D orthographic drafting viewport, using
 * drei's <Text> SDF renderer (it manages its own geometry and disposal).
 * - Anchored at entity.position; only rotation[2] applies (2D entities rotate within the work plane).
 * - fontSize = entity.height (cap-height in model units); anchorX from entity.anchor (default
 *   'left'); anchorY always 'middle'.
 * - Must be rendered inside the -renderOrigin group in Viewport2D.tsx (U4 convention).
 */

import { Text } from '@react-three/drei';
import type { TextEntity } from '@core/model/types';
import { SELECTION_COLOR } from '../../viewportPalette';

export function TextRenderer2D({
  entity: { content, height, position, rotation, color, anchor },
  selected,
}: {
  entity: TextEntity;
  selected: boolean;
}): React.ReactElement {
  return (
    <Text
      position={[position[0], position[1], position[2]]}
      rotation={[0, 0, rotation[2] ?? 0]}
      fontSize={height}
      color={selected ? SELECTION_COLOR : color}
      anchorX={anchor ?? 'left'}
      anchorY="middle"
    >
      {content}
    </Text>
  );
}
