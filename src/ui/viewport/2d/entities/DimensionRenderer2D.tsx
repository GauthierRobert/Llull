/**
 * @layer ui/viewport/2d
 *
 * Render branch for `kind:'dimension'` entities in the 2D orthographic drafting viewport.
 *
 * Supports four dimension kinds (see dimensionGeometry): linear (horizontal distance between two
 * point/line entities), aligned (full distance, line parallel to the segment), radial (radius of a
 * circle, arc or ellipse) and angular (angle at the vertex of two arms).
 *
 * Lines are memoized on the referenced entities and disposed by PlacedLineObject (R9); the value
 * text is drei <Text> (no disposal needed). Missing or wrong-kind references render nothing.
 * Value = entity.label if set, else computed. Precision = entity.precision if set, else document
 * displayPrecision. Must be rendered inside the -renderOrigin group in Viewport2D.tsx.
 */

import { useMemo, useRef } from 'react';
import type * as THREE from 'three';
import { Text } from '@react-three/drei';
import type { CadDocument, DimensionEntity } from '@core/model/types';
import { ORIGIN } from '@lib/vec3';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';
import { SELECTION_COLOR } from '@ui/viewport/viewportPalette';
import { useMinScreenSize } from '../useMinScreenSize';
import { PlacedLineObject } from './PlacedLineObject';
import { DEFAULT_OFFSET, dimensionDrawing } from './dimensionGeometry';

const DIM_LINE_COLOR = '#333333';
const TEXT_HEIGHT = 0.5;

interface DimensionRenderer2DProps {
  entity: DimensionEntity;
  doc: CadDocument;
  selected: boolean;
}

export function DimensionRenderer2D({
  entity,
  doc,
  selected,
}: DimensionRenderer2DProps): React.ReactElement | null {
  const { dimensionKind, entityIds, offset: rawOffset, precision, label, color, position } = entity;
  const offset = rawOffset ?? DEFAULT_OFFSET;
  const textRef = useRef<THREE.Group>(null);
  useMinScreenSize(textRef, TEXT_HEIGHT);
  const dimColor = selected ? SELECTION_COLOR : color || DIM_LINE_COLOR;

  const drawing = useMemo(
    () =>
      dimensionDrawing(
        dimensionKind,
        entityIds.map((id) => doc.entities[id]),
        offset,
        dimColor,
      ),
    [dimensionKind, entityIds, doc.entities, offset, dimColor],
  );
  if (!drawing) return null;

  const displayText =
    label ||
    (dimensionKind === 'angular'
      ? `${drawing.value.toFixed(1)}°`
      : drawing.value.toFixed(precision ?? doc.displayPrecision));

  return (
    <group position={[position[0], position[1], position[2]]}>
      {drawing.lines && <PlacedLineObject object={drawing.lines} position={ORIGIN} />}
      <group ref={textRef} position={[drawing.textX, drawing.textY, 0.01]}>
        <Text
          font={TEXT_FONT_URL}
          fontSize={TEXT_HEIGHT}
          color={dimColor}
          anchorX="center"
          anchorY="middle"
        >
          {displayText}
        </Text>
      </group>
    </group>
  );
}
