/**
 * Technical-drawing primitives (ISO 128 line types) — the one 2D drawing vocabulary shared by the
 * building plan, the solids' orthographic views, the 2D viewport, DXF and sheet exporters.
 * @layer model
 */

import type { Vec2 } from './vectors';

/**
 * Line type of a primitive:
 * - `cut`: thick continuous outline of material cut by the section plane (filled / hatched);
 * - `visible`: thick continuous visible edge or outline;
 * - `thin`: thin continuous line (edges beyond the cut, hatching, leaders);
 * - `hidden`: thin dashed hidden edge;
 * - `center`: thin chain line (long dash, dot) — axes and centre marks;
 * - `annotation`: text and symbols.
 */
type DrawingStyle = 'cut' | 'visible' | 'thin' | 'hidden' | 'center' | 'annotation';

/**
 * ISO 128 line patterns, [dash, gap, dash, gap, …] in pattern units — the one definition every
 * renderer scales: the 2D view (model units), SVG sheets (paper mm) and DXF line types.
 */
export const LINE_PATTERNS = {
  /** Type 02, dashed: hidden edges. */
  hidden: [2, 1],
  /** Type 04, long-dash dot (chain): axes, centre marks, grids, pitch circles. */
  center: [6, 1, 1, 1],
} as const;

/** `pattern` scaled by `unit` as an SVG `stroke-dasharray` value. @pure */
export function dashArray(pattern: ReadonlyArray<number>, unit: number): string {
  return pattern.map((length) => Number((length * unit).toFixed(3))).join(' ');
}

/**
 * Area fill of a closed polygon or circle: hatch (ANSI31, 45°) or solid (steel). Fill is explicit
 * data — no renderer infers it from the line style.
 */
export type DrawingFill = 'hatch' | 'solid';

export type DrawingPrimitive =
  | {
      readonly type: 'polygon';
      readonly layer: string;
      readonly style: DrawingStyle;
      readonly points: Vec2[];
      readonly fill?: DrawingFill;
      /** Holes excluded from the fill (their outlines are separate primitives). */
      readonly holes?: Vec2[][];
    }
  | {
      readonly type: 'polyline';
      readonly layer: string;
      readonly style: DrawingStyle;
      readonly points: Vec2[];
    }
  | {
      readonly type: 'line';
      readonly layer: string;
      readonly style: DrawingStyle;
      readonly a: Vec2;
      readonly b: Vec2;
    }
  | {
      readonly type: 'arc';
      readonly layer: string;
      readonly style: DrawingStyle;
      readonly center: Vec2;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
    }
  | {
      readonly type: 'circle';
      readonly layer: string;
      readonly style: DrawingStyle;
      readonly center: Vec2;
      readonly radius: number;
      readonly fill?: DrawingFill;
    }
  | {
      readonly type: 'text';
      readonly layer: string;
      readonly style: DrawingStyle;
      readonly at: Vec2;
      readonly height: number;
      readonly content: string;
    }
  | {
      readonly type: 'dimension';
      readonly layer: string;
      readonly style: DrawingStyle;
      /** Measured points; the dimension line sits `offset` away on the right of a→b. */
      readonly a: Vec2;
      readonly b: Vec2;
      readonly offset: number;
      readonly label: string;
    };

/** [minX, minY, maxX, maxY] of `primitives` (arcs and circles by their full circle); [0, 0, 0, 0] when empty. @pure */
export function drawingBounds(primitives: ReadonlyArray<DrawingPrimitive>): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point: Vec2, pad = 0): void => {
    minX = Math.min(minX, point[0] - pad);
    minY = Math.min(minY, point[1] - pad);
    maxX = Math.max(maxX, point[0] + pad);
    maxY = Math.max(maxY, point[1] + pad);
  };
  for (const primitive of primitives) {
    switch (primitive.type) {
      case 'polygon':
      case 'polyline':
        primitive.points.forEach((point) => include(point));
        break;
      case 'line':
        include(primitive.a);
        include(primitive.b);
        break;
      case 'arc':
      case 'circle':
        include(primitive.center, primitive.radius);
        break;
      case 'text':
        include(primitive.at, primitive.height);
        break;
      case 'dimension':
        include(primitive.a, primitive.offset * 1.5);
        include(primitive.b, primitive.offset * 1.5);
        break;
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
}

/** Join tolerance of a drawing: a millionth of its extent (at least a millionth of a unit). @pure */
export function drawingTolerance(primitives: ReadonlyArray<DrawingPrimitive>): number {
  const [minX, minY, maxX, maxY] = drawingBounds(primitives);
  return Math.max(maxX - minX, maxY - minY, 1) * 1e-6;
}
