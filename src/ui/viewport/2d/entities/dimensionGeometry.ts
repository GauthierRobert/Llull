// Three.js presentation of a 2D dimension: the construction (value, label anchor, strokes) comes from @core/geometry/dimensionAnnotation,
// the one source render_view shares.

import * as THREE from 'three';
import type { DimensionEntity, Entity } from '@core/model/types';
import { DEFAULT_DIMENSION_OFFSET, dimensionDrawing as constructDimension } from '@core/geometry/dimensionAnnotation';
import { anchoredGeometry } from '../../lineGeometry';

export const DEFAULT_OFFSET = DEFAULT_DIMENSION_OFFSET;

interface DimensionDrawing {
  /** Length, radius, diameter, or angle in degrees. */
  value: number;
  /** Label anchor in the entity's XY plane. */
  textX: number;
  textY: number;
  /** Null when degenerate (label only). */
  lines: THREE.LineSegments | null;
}

/** `null` references = dangling. @failure missing or wrong-kind references -> null */
export function dimensionDrawing(
  kind: DimensionEntity['dimensionKind'],
  refs: ReadonlyArray<Entity | null | undefined>,
  offset: number,
  color: string,
): DimensionDrawing | null {
  const drawing = constructDimension(kind, refs, offset);
  if (!drawing) return null;
  const vertices = drawing.segments.flat();
  let lines: THREE.LineSegments | null = null;
  if (vertices.length > 0) {
    const { geometry, anchor } = anchoredGeometry(vertices);
    lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
    lines.position.set(...anchor);
  }
  return { value: drawing.value, textX: drawing.textAt[0], textY: drawing.textAt[1], lines };
}
