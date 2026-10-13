// 2D `kind:'dimension'` (linear / aligned / radial / angular, dimensionGeometry): lines memoized on the referenced
// entities (disposed by PlacedLineObject), value as drei <Text> = label ?? computed at precision ?? displayPrecision.
// Bad references render nothing. Lives inside Viewport2D's -renderOrigin group.

import { useMemo, useRef } from 'react';
import type * as THREE from 'three';
import { Text } from '@react-three/drei';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@ui/store';
import type { DimensionEntity } from '@core/model/types';
import { ORIGIN } from '@lib/vec3';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';
import { SELECTION_COLOR } from '@ui/viewport/viewportPalette';
import { useMinScreenSize } from '../useMinScreenSize';
import { PlacedLineObject } from './PlacedLineObject';
import { DEFAULT_OFFSET, dimensionDrawing } from './dimensionGeometry';

const DIM_LINE_COLOR = '#333333';
const TEXT_HEIGHT = 0.5;

export function DimensionRenderer2D({ entity, selected }: { entity: DimensionEntity; selected: boolean }): React.ReactElement | null {
  const { dimensionKind, entityIds, offset: rawOffset, precision, label, color, position } = entity;
  const offset = rawOffset ?? DEFAULT_OFFSET;
  const textRef = useRef<THREE.Group>(null);
  useMinScreenSize(textRef, TEXT_HEIGHT);
  const dimColor = selected ? SELECTION_COLOR : color || DIM_LINE_COLOR;

  // Only the referenced entities (shallow): unrelated edits do not rebuild.
  const referenced = useStore(useShallow((s) => entityIds.map((id) => s.document.entities[id])));
  const displayPrecision = useStore((s) => s.document.displayPrecision);

  const drawing = useMemo(
    () => dimensionDrawing(dimensionKind, referenced, offset, dimColor),
    [dimensionKind, referenced, offset, dimColor],
  );
  if (!drawing) return null;

  const displayText =
    label || (dimensionKind === 'angular' ? `${drawing.value.toFixed(1)}°` : drawing.value.toFixed(precision ?? displayPrecision));

  return (
    <group position={[position[0], position[1], position[2]]}>
      {drawing.lines && <PlacedLineObject object={drawing.lines} position={ORIGIN} />}
      <group ref={textRef} position={[drawing.textX, drawing.textY, 0.01]}>
        <Text font={TEXT_FONT_URL} fontSize={TEXT_HEIGHT} color={dimColor} anchorX="center" anchorY="middle">
          {displayText}
        </Text>
      </group>
    </group>
  );
}
