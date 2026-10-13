/**
 * The one SVG painter of technical-drawing primitives on a sheet (plans, elevations, sections,
 * anchor plans): ISO line weights and patterns come from the sheet style classes (`sheetFrame`).
 * @layer domain-aec
 */

import { clamp } from '@lib/clamp';
import { wrapAngle } from '@lib/angle';
import type { Vec2 } from '@core/model/types';
import type { DrawingPrimitive } from '@core/model/drawing';
import { n, readableDimensionLabel, svgPoints, svgText } from './sheetFrame';

/** Sheet style class of a line type (`filled`: a closed area that takes its poché). */
function classOf(style: DrawingPrimitive['style'], filled: boolean): string {
  switch (style) {
    case 'cut':
      return filled ? 'cut' : 'cut-line';
    case 'visible':
      return 'cut-line';
    case 'hidden':
      return 'hidden';
    case 'center':
      return 'center';
    case 'annotation':
    case 'thin':
      return 'thin';
  }
}

/** `<line>` between two paper points. */
export const svgLine = (a: Vec2, b: Vec2, cssClass: string): string =>
  `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" class="${cssClass}"/>`;

/**
 * Aligned dimension between paper points `a`, `b`: extension lines, the dimension line `side`
 * paper mm off a→b (positive = left of a→b on paper), oblique ticks and a readable label.
 */
export function paperDimension(
  a: Vec2,
  b: Vec2,
  side: number,
  label: string,
  textSize: number,
): string[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const normal: Vec2 = [dy / length, -dx / length];
  const shift = (point: Vec2, distance: number): Vec2 => [
    point[0] + normal[0] * distance,
    point[1] + normal[1] * distance,
  ];
  const sign = Math.sign(side);
  const [da, db] = [shift(a, side), shift(b, side)];
  const parts = [
    svgLine(shift(a, sign * 1.5), shift(a, side + sign * 1.5), 'dim'),
    svgLine(shift(b, sign * 1.5), shift(b, side + sign * 1.5), 'dim'),
    svgLine(da, db, 'dim'),
    ...[da, db].map((end) => svgLine([end[0] - 1, end[1] + 1], [end[0] + 1, end[1] - 1], 'dim')),
  ];
  const { angle, middle } = readableDimensionLabel(da, db, dx, dy);
  parts.push(svgText(middle[0], middle[1], textSize, 'middle', label, angle));
  return parts;
}

/** Paints primitives through a model → paper map at `paperPerUnit` paper mm per model unit. */
export class DrawingPainter {
  readonly parts: string[] = [];

  constructor(
    readonly map: (point: Vec2) => Vec2,
    readonly paperPerUnit: number,
  ) {}

  private points(points: ReadonlyArray<Vec2>): string {
    return svgPoints(points.map((point) => this.map(point)));
  }

  paint(primitive: DrawingPrimitive): void {
    const cssClass = (filled: boolean): string => classOf(primitive.style, filled);
    switch (primitive.type) {
      case 'polygon': {
        const loops = [primitive.points, ...(primitive.holes ?? [])];
        const path = loops.map((loop) => `M${this.points(loop).replace(/ /g, 'L')}Z`).join('');
        const filled = primitive.fill === 'solid' || primitive.style === 'cut';
        const area = primitive.fill === 'hatch' ? 'cut-hatch' : cssClass(filled);
        this.parts.push(`<path d="${path}" fill-rule="evenodd" class="${area}"/>`);
        return;
      }
      case 'polyline':
        this.parts.push(
          `<polyline points="${this.points(primitive.points)}" class="${cssClass(false)}"/>`,
        );
        return;
      case 'line':
        this.parts.push(svgLine(this.map(primitive.a), this.map(primitive.b), cssClass(false)));
        return;
      case 'circle': {
        const [cx, cy] = this.map(primitive.center);
        const r = n(primitive.radius * this.paperPerUnit);
        const filled = primitive.style === 'cut';
        this.parts.push(
          `<circle cx="${n(cx)}" cy="${n(cy)}" r="${r}" class="${cssClass(filled)}"/>`,
        );
        return;
      }
      case 'arc': {
        const { center, radius, startAngle, endAngle } = primitive;
        const at = (angle: number): Vec2 =>
          this.map([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
        const [start, end] = [at(startAngle), at(endAngle)];
        const large = wrapAngle(endAngle - startAngle) > Math.PI ? 1 : 0;
        const r = n(radius * this.paperPerUnit);
        this.parts.push(
          `<path d="M ${n(start[0])} ${n(start[1])} A ${r} ${r} 0 ${large} 1 ${n(end[0])} ${n(end[1])}" class="${cssClass(false)}"/>`,
        );
        return;
      }
      case 'text': {
        const size = Math.max(primitive.height * this.paperPerUnit, 1.8);
        const [x, y] = this.map(primitive.at);
        this.parts.push(svgText(x, y + size * 0.35, size, 'middle', primitive.content));
        return;
      }
      case 'dimension': {
        // Model "right of a→b" becomes "left of a→b" once Y is flipped on paper.
        const gap = clamp(primitive.offset * this.paperPerUnit, 6, 14);
        this.parts.push(
          ...paperDimension(
            this.map(primitive.a),
            this.map(primitive.b),
            -gap,
            primitive.label,
            2.5,
          ),
        );
        return;
      }
    }
  }
}
