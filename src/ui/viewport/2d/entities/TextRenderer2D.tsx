/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'text'` entities in the 2D orthographic drafting viewport, using
 * drei's <Text> SDF renderer (it manages its own geometry and disposal).
 * - Anchored at entity.position; only rotation[2] applies (2D entities rotate within the work plane).
 * - fontSize = entity.height (cap-height in model units); anchorX from entity.anchor (default
 *   'left'); anchorY always 'middle'. Uses the self-hosted font (`TEXT_FONT_URL`): troika would fetch
 *   a CDN font otherwise, which hangs offline.
 * - Scaled about its anchor so it never drops below the minimum on-screen size when zoomed out
 *   (same readability rule as dimension text).
 * - Must be rendered inside the -renderOrigin group in Viewport2D.tsx (U4 convention).
 */

import { useRef } from 'react';
import type * as THREE from 'three';
import { Text } from '@react-three/drei';
import type { TextEntity } from '@core/model/types';
import { TEXT_FONT_URL, toAnchorX } from '@ui/viewport/textFont';
import { SELECTION_COLOR } from '../../viewportPalette';
import { useMinScreenSize } from '../useMinScreenSize';

export function TextRenderer2D({
  entity: { content, height, position, rotation, color, anchor },
  selected,
}: {
  entity: TextEntity;
  selected: boolean;
}): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);
  useMinScreenSize(groupRef, height);
  return (
    <group
      ref={groupRef}
      position={[position[0], position[1], position[2]]}
      rotation={[0, 0, rotation[2] ?? 0]}
    >
      <Text
        font={TEXT_FONT_URL}
        fontSize={height}
        color={selected ? SELECTION_COLOR : color}
        anchorX={toAnchorX(anchor)}
        textAlign={toAnchorX(anchor)}
        anchorY="middle"
      >
        {content}
      </Text>
    </group>
  );
}
