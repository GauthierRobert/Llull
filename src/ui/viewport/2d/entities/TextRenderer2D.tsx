/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'text'` entities in the 2D orthographic drafting viewport.
 *
 * Uses drei's <Text> SDF renderer inside the orthographic camera scene.
 * - Anchored at entity.position (XY plane, z=0 by default for 2D annotations).
 * - Rotation: only the Z component (entity.rotation[2]) is applied — 2D entities
 *   rotate within the work plane.
 * - fontSize = entity.height (cap-height in model units).
 * - anchorX derived from entity.anchor; default 'left'. anchorY always 'middle'.
 * - Selection tint: color switches to selection blue when selected.
 * - drei <Text> manages its own SDF geometry and disposal — no manual cleanup needed.
 * - Must be rendered inside the -renderOrigin group in Viewport2D.tsx (U4 convention).
 */

import { Text } from '@react-three/drei';
import type { TextEntity } from '@core/model/types';

interface TextRenderer2DProps {
  entity: TextEntity;
  selected: boolean;
}

/** Derive anchorX value expected by drei <Text> from our anchor field. */
function toAnchorX(anchor: TextEntity['anchor']): 'left' | 'center' | 'right' {
  if (anchor === 'center') return 'center';
  if (anchor === 'right') return 'right';
  return 'left';
}

export function TextRenderer2D({ entity, selected }: TextRenderer2DProps): React.ReactElement {
  const { content, height, position, rotation, color, anchor } = entity;

  const anchorX = toAnchorX(anchor);
  const textColor = selected ? '#5b8dee' : color;

  // 2D work-plane entities only rotate around Z (the axis normal to the drafting plane).
  const rotZ = rotation[2] ?? 0;

  return (
    <Text
      position={[position[0], position[1], position[2]]}
      rotation={[0, 0, rotZ]}
      fontSize={height}
      color={textColor}
      anchorX={anchorX}
      anchorY="middle"
    >
      {content}
    </Text>
  );
}
