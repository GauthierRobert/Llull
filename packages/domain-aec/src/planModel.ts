/**
 * @layer domain-aec
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { BimCategory, BuildingLevel, OpeningElement, WallElement } from '@core/model/building';
import { pointAlong, wallFrame } from './wallGeometry';
import { CATEGORY_LAYER } from './entities';

type PlanStyle = 'cut' | 'thin' | 'hidden' | 'annotation';

/** Area fill of a cut: concrete / masonry hatch (ANSI31) or solid (steel). */
export type PlanFill = 'hatch' | 'solid';

export type PlanPrimitive =
  | {
      readonly type: 'polygon';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly points: Vec2[];
      readonly fill?: PlanFill;
      /** Holes excluded from the fill (their outlines are separate primitives). */
      readonly holes?: Vec2[][];
    }
  | {
      readonly type: 'polyline';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly points: Vec2[];
    }
  | {
      readonly type: 'line';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly a: Vec2;
      readonly b: Vec2;
    }
  | {
      readonly type: 'arc';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly center: Vec2;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
    }
  | {
      readonly type: 'circle';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly center: Vec2;
      readonly radius: number;
    }
  | {
      readonly type: 'text';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly at: Vec2;
      readonly height: number;
      readonly content: string;
    }
  | {
      readonly type: 'dimension';
      readonly layer: string;
      readonly style: PlanStyle;
      /** Measured points; the dimension line sits `offset` away on the right of a→b. */
      readonly a: Vec2;
      readonly b: Vec2;
      readonly offset: number;
      readonly label: string;
    };

export interface PlanDrawing {
  readonly level: BuildingLevel;
  readonly primitives: PlanPrimitive[];
  /** [minX, minY, maxX, maxY] of all primitives (model units). */
  readonly bounds: readonly [number, number, number, number];
}

export const DIMENSION_LAYER = 'A-ANNO-DIMS';

/** The document slices a plan depends on. */
export type PlanSource = Pick<CadDocument, 'building' | 'units'>;

export function layerName(category: BimCategory): string {
  return CATEGORY_LAYER[category].name;
}

export function band(
  axis: Pick<WallElement, 'start' | 'end'>,
  s0: number,
  s1: number,
  halfWidth: number,
): Vec2[] {
  const frame = wallFrame(axis);
  return [
    pointAlong(axis, frame, s0, -halfWidth),
    pointAlong(axis, frame, s1, -halfWidth),
    pointAlong(axis, frame, s1, halfWidth),
    pointAlong(axis, frame, s0, halfWidth),
  ];
}

export const thinLine = (layer: string, a: Vec2, b: Vec2): PlanPrimitive => ({
  type: 'line',
  layer,
  style: 'thin',
  a,
  b,
});

export const annotationText = (
  layer: string,
  at: Vec2,
  height: number,
  content: string,
): PlanPrimitive => ({ type: 'text', layer, style: 'annotation', at, height, content });

export function isCut(opening: OpeningElement, cutHeight: number): boolean {
  return opening.sillHeight < cutHeight && opening.sillHeight + opening.height > cutHeight;
}
