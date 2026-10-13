// 3D `kind:'text'`: drei <Text> SDF (owns its geometry + disposal), fontSize = cap height, anchorY 'middle' (matches
// the 0.6 × height heuristic in scene.ts). troika compiles one SDF atlas per font: many distinct texts can spike a frame.

import { Text } from '@react-three/drei';
import type { TextEntity } from '@core/model/types';
import { TEXT_FONT_URL, toAnchorX } from '@ui/viewport/textFont';
import { selectOnClick } from '@ui/viewport/selectClick';
import { SELECTION_COLOR } from '@ui/viewport/viewportPalette';

interface TextMeshProps {
  entity: TextEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

export function TextMesh({ entity, selected, onSelect }: TextMeshProps): React.ReactElement {
  const { content, height, position, rotation, color, anchor } = entity;

  return (
    <Text
      font={TEXT_FONT_URL}
      position={position}
      rotation={rotation}
      fontSize={height}
      color={selected ? SELECTION_COLOR : color}
      anchorX={toAnchorX(anchor)}
      anchorY="middle"
      onClick={selectOnClick(entity.id, onSelect)}
    >
      {content}
    </Text>
  );
}
