/** SVG painter of technical-drawing primitives on a sheet (ISO line weights come from the sheet style classes). */

import type { Vec2 } from '../../model/vectors';
import type { DrawingFill, DrawingPrimitive } from '../../model/drawing';
import { clamp } from '../../lib/clamp';
import { readableAngle, toDegrees, wrapAngle } from '../../lib/angle';
import { escapeXml } from '../../lib/escapeXml';

/** SVG number text: two decimals, no trailing zeros, no negative zero. */
export const n = (value: number): string => String(Math.round(value * 100) / 100 + 0);

const classOf = (style: DrawingPrimitive['style']): string => {
  switch (style) {
    case 'cut':
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
};

/** Class of a closed area: its explicit fill or just its outline. */
const areaClass = (fill: DrawingFill | undefined, outline: string): string =>
  fill === 'solid' ? 'cut' : fill === 'hatch' ? 'cut-hatch' : outline;

export const svgLine = (a: Vec2, b: Vec2, cssClass: string): string =>
  `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" class="${cssClass}"/>`;

/** `<text>` at paper point (`x`, `y`), XML-escaped, optionally rotated about its anchor. */
export function svgText(x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end', content: string, rotation = 0): string {
  const transform = rotation !== 0 ? ` transform="rotate(${n(rotation)} ${n(x)} ${n(y)})"` : '';
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" text-anchor="${anchor}"${transform}>${escapeXml(content)}</text>`;
}

/** Aligned dimension between paper points: extension lines, dimension line `side` mm off a→b, ticks, readable label. */
export function paperDimension(a: Vec2, b: Vec2, side: number, label: string): string[] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const normal: Vec2 = [dy / length, -dx / length];
  const shift = (point: Vec2, distance: number): Vec2 => [point[0] + normal[0] * distance, point[1] + normal[1] * distance];
  const sign = Math.sign(side);
  const [da, db] = [shift(a, side), shift(b, side)];
  const radians = readableAngle(Math.atan2(dy, dx));
  const middle: Vec2 = [(da[0] + db[0]) / 2 + Math.sin(radians) * 1.2, (da[1] + db[1]) / 2 - Math.cos(radians) * 1.2];
  return [
    svgLine(shift(a, sign * 1.5), shift(a, side + sign * 1.5), 'dim'),
    svgLine(shift(b, sign * 1.5), shift(b, side + sign * 1.5), 'dim'),
    svgLine(da, db, 'dim'),
    ...[da, db].map((end) => svgLine([end[0] - 1, end[1] + 1], [end[0] + 1, end[1] - 1], 'dim')),
    svgText(middle[0], middle[1], 2.5, 'middle', label, toDegrees(radians)),
  ];
}

/** Paints primitives through a model → paper map at `perUnit` paper mm per model unit. */
export class SheetPainter {
  readonly parts: string[] = [];

  constructor(
    readonly map: (point: Vec2) => Vec2,
    readonly perUnit: number,
  ) {}

  private points(points: ReadonlyArray<Vec2>): string {
    return points.map((point) => this.map(point).map(n).join(',')).join(' ');
  }

  paint(primitive: DrawingPrimitive): void {
    const outline = classOf(primitive.style);
    switch (primitive.type) {
      case 'polygon': {
        const path = [primitive.points, ...(primitive.holes ?? [])].map((loop) => `M${this.points(loop).replace(/ /g, 'L')}Z`).join('');
        this.parts.push(`<path d="${path}" fill-rule="evenodd" class="${areaClass(primitive.fill, outline)}"/>`);
        return;
      }
      case 'polyline':
        this.parts.push(`<polyline points="${this.points(primitive.points)}" class="${outline}"/>`);
        return;
      case 'line':
        this.parts.push(svgLine(this.map(primitive.a), this.map(primitive.b), outline));
        return;
      case 'circle': {
        const [cx, cy] = this.map(primitive.center);
        this.parts.push(
          `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(primitive.radius * this.perUnit)}" class="${areaClass(primitive.fill, outline)}"/>`,
        );
        return;
      }
      case 'arc': {
        const { center, radius, startAngle, endAngle } = primitive;
        const at = (angle: number): Vec2 => this.map([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
        const [start, end] = [at(startAngle), at(endAngle)];
        const r = n(radius * this.perUnit);
        const large = wrapAngle(endAngle - startAngle) > Math.PI ? 1 : 0;
        this.parts.push(
          `<path d="M ${n(start[0])} ${n(start[1])} A ${r} ${r} 0 ${large} 1 ${n(end[0])} ${n(end[1])}" class="${outline}"/>`,
        );
        return;
      }
      case 'text': {
        const size = Math.max(primitive.height * this.perUnit, 1.8);
        const [x, y] = this.map(primitive.at);
        this.parts.push(svgText(x, y + size * 0.35, size, 'middle', primitive.content));
        return;
      }
      case 'dimension': {
        const gap = clamp(primitive.offset * this.perUnit, 6, 14);
        this.parts.push(...paperDimension(this.map(primitive.a), this.map(primitive.b), -gap, primitive.label));
        return;
      }
    }
  }
}
