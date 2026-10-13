// 2D `kind:'text'`: drei <Text> (self-managed geometry) with the self-hosted font (troika's CDN default hangs offline);
// rotation[2] only, fontSize = cap height, anchorY 'middle'; scaled about its anchor to a minimum on-screen size like
// dimension text. Lives inside Viewport2D's -renderOrigin group.

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
    <group ref={groupRef} position={position} rotation={[0, 0, rotation[2] ?? 0]}>
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
