/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'text'` entities in the 3D perspective viewport.
 *
 * Uses drei's <Text> SDF renderer for crisp text at any zoom level.
 * - Placed at entity.position, rotated by entity.rotation (extrinsic XYZ).
 * - fontSize = entity.height (cap-height in model units).
 * - anchorX derived from entity.anchor ('left' | 'center' | 'right'); default 'left'.
 * - anchorY is always 'middle' — consistent with the 0.6 × height heuristic in scene.ts.
 * - Click → onSelect; Shift/Ctrl/Meta → additive selection.
 * - Selection tint applied via drei <Text> color prop.
 * - drei <Text> manages its own SDF geometry and disposal — no manual cleanup needed
 *   for the text itself (drei documentation; verified: no WebGL warnings in dev mode).
 */

import type { ThreeEvent } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import type { TextEntity } from '@core/model/types';

interface TextMeshProps {
  entity: TextEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}

/** Derive anchorX value expected by drei <Text> from our anchor field. */
function toAnchorX(anchor: TextEntity['anchor']): 'left' | 'center' | 'right' {
  if (anchor === 'center') return 'center';
  if (anchor === 'right') return 'right';
  return 'left';
}

export function TextMesh({ entity, selected, onSelect }: TextMeshProps): React.ReactElement {
  const { content, height, position, rotation, color, anchor } = entity;

  const anchorX = toAnchorX(anchor);
  const textColor = selected ? '#5b8dee' : color;

  function handleClick(e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation();
    const additive = e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
    onSelect(entity.id, additive);
  }

  return (
    <Text
      position={[position[0], position[1], position[2]]}
      rotation={[rotation[0], rotation[1], rotation[2]]}
      fontSize={height}
      color={textColor}
      anchorX={anchorX}
      anchorY="middle"
      onClick={handleClick}
    >
      {content}
    </Text>
  );
}
