import type { CadDocument, Vec2 } from '@core/model/types';
import type { BimCategory, BuildingLevel, OpeningElement, WallElement } from '@core/model/building';
import { pointAlong, wallFrame } from '../geometry/wallGeometry';
import { CATEGORY_LAYER } from '../evaluate/entities';
import type { DrawingPrimitive } from '@core/model/drawing';

export interface PlanDrawing {
  readonly level: BuildingLevel;
  readonly primitives: DrawingPrimitive[];
  /** [minX, minY, maxX, maxY] of all primitives (model units). */
  readonly bounds: readonly [number, number, number, number];
}

export const DIMENSION_LAYER = 'A-ANNO-DIMS';

/** The document slices a plan depends on. */
export type PlanSource = Pick<CadDocument, 'building' | 'units'>;

export function layerName(category: BimCategory): string {
  return CATEGORY_LAYER[category].name;
}

export function band(axis: Pick<WallElement, 'start' | 'end'>, s0: number, s1: number, halfWidth: number): Vec2[] {
  const frame = wallFrame(axis);
  return [
    pointAlong(axis, frame, s0, -halfWidth),
    pointAlong(axis, frame, s1, -halfWidth),
    pointAlong(axis, frame, s1, halfWidth),
    pointAlong(axis, frame, s0, halfWidth),
  ];
}

export const thinLine = (layer: string, a: Vec2, b: Vec2): DrawingPrimitive => ({
  type: 'line',
  layer,
  style: 'thin',
  a,
  b,
});

export const annotationText = (layer: string, at: Vec2, height: number, content: string): DrawingPrimitive => ({
  type: 'text',
  layer,
  style: 'annotation',
  at,
  height,
  content,
});

export function isCut(opening: OpeningElement, cutHeight: number): boolean {
  return opening.sillHeight < cutHeight && opening.sillHeight + opening.height > cutHeight;
}
