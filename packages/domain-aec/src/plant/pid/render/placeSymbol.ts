/** Places a symbol on the sheet: its shapes become `DrawingPrimitive`s (the vocabulary the 2D view, SVG and DXF share). */

import type { DrawingPrimitive } from '@core/model/drawing';
import type { Vec2 } from '@core/model/vectors';
import type { PidSymbol, Shape } from '../symbols/shapes';

/** Longest text a label may carry on a sheet (hostile imports): longer text ends in an ellipsis. */
export const MAX_LABEL = 48;
export const clip = (content: string): string => (content.length > MAX_LABEL ? `${content.slice(0, MAX_LABEL - 1)}…` : content);

export interface Placement {
  readonly at: Vec2;
  readonly angleDeg: number;
  /** Mirrors the symbol across its flow axis (a check valve against the drawn direction). */
  readonly flip?: boolean;
  readonly layer: string;
}

export function placePoint(p: Vec2, placement: Placement): Vec2 {
  const angle = (placement.angleDeg * Math.PI) / 180;
  const x = placement.flip === true ? -p[0] : p[0];
  return [placement.at[0] + x * Math.cos(angle) - p[1] * Math.sin(angle), placement.at[1] + x * Math.sin(angle) + p[1] * Math.cos(angle)];
}

const styleOf = (shape: Shape): 'visible' | 'thin' | 'hidden' => (shape.t === 'text' ? 'visible' : (shape.style ?? 'visible'));

export function placeShape(shape: Shape, placement: Placement): DrawingPrimitive {
  const { layer } = placement;
  switch (shape.t) {
    case 'circle':
      return {
        type: 'circle',
        layer,
        style: styleOf(shape),
        center: placePoint(shape.c, placement),
        radius: shape.r,
        ...(shape.fill === true ? { fill: 'solid' as const } : {}),
      };
    case 'text':
      return {
        type: 'text',
        layer: 'PID-TEXT',
        style: 'annotation',
        at: placePoint(shape.at, { ...placement, angleDeg: 0, flip: false }),
        height: shape.h,
        content: clip(shape.s),
      };
    case 'line': {
      const points = shape.pts.map((p) => placePoint(p, placement));
      if (shape.closed === true)
        return { type: 'polygon', layer, style: styleOf(shape), points, ...(shape.fill === true ? { fill: 'solid' as const } : {}) };
      return { type: 'polyline', layer, style: styleOf(shape), points };
    }
  }
}

export const placeSymbol = (symbol: PidSymbol, placement: Placement): DrawingPrimitive[] =>
  symbol.shapes.map((shape) => placeShape(shape, placement));

/** A text label of `height` mm centred at `at`. */
export const label = (at: Vec2, height: number, content: string): DrawingPrimitive => ({
  type: 'text',
  layer: 'PID-TEXT',
  style: 'annotation',
  at,
  height,
  content: clip(content),
});
