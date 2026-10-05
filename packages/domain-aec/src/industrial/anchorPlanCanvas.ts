/**
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import { escapeXml } from '@lib/escapeXml';
import { distance } from '@lib/polygon';
import { n, type Viewport } from '../sheet';
import { ROW_HEIGHT } from './anchorPlanLayout';

export class PlanCanvas {
  readonly parts: string[] = [];

  constructor(
    private readonly centre: Vec2,
    private readonly scale: number,
    private readonly viewport: Viewport,
  ) {}

  map([x, y]: Vec2): Vec2 {
    return [
      this.viewport.x + this.viewport.width / 2 + (x - this.centre[0]) / this.scale,
      this.viewport.y + this.viewport.height / 2 - (y - this.centre[1]) / this.scale,
    ];
  }

  paper(millimetres: number): number {
    return millimetres / this.scale;
  }

  line(a: Vec2, b: Vec2, cssClass: string, extra = ''): void {
    this.parts.push(
      `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" class="${cssClass}"${extra}/>`,
    );
  }

  text(at: Vec2, size: number, content: string, anchor = 'middle', rotation = 0): void {
    const transform =
      rotation !== 0 ? ` transform="rotate(${n(rotation)} ${n(at[0])} ${n(at[1])})"` : '';
    this.parts.push(
      `<text x="${n(at[0])}" y="${n(at[1])}" font-size="${n(size)}" text-anchor="${anchor}"${transform}>${escapeXml(content)}</text>`,
    );
  }

  /** Aligned dimension between two model points, drawn `side` paper-mm off the measured line. */
  dimension(a: Vec2, b: Vec2, side: number, label: string): void {
    const [pa, pb] = [this.map(a), this.map(b)];
    const length = distance(pa, pb);
    if (length === 0) return;
    const normal: Vec2 = [(pb[1] - pa[1]) / length, -(pb[0] - pa[0]) / length];
    const shift = (p: Vec2, d: number): Vec2 => [p[0] + normal[0] * d, p[1] + normal[1] * d];
    const [da, db] = [shift(pa, side), shift(pb, side)];
    const sign = Math.sign(side);
    this.line(shift(pa, sign * 1), shift(pa, side + sign * 1.5), 'dim');
    this.line(shift(pb, sign * 1), shift(pb, side + sign * 1.5), 'dim');
    this.line(da, db, 'dim');
    for (const end of [da, db])
      this.line([end[0] - 1, end[1] + 1], [end[0] + 1, end[1] - 1], 'dim');
    let angle = (Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180) / Math.PI;
    if (angle > 90 || angle <= -90) angle += 180;
    const radians = (angle * Math.PI) / 180;
    this.text(
      [
        (da[0] + db[0]) / 2 + Math.sin(radians) * 1.2,
        (da[1] + db[1]) / 2 - Math.cos(radians) * 1.2,
      ],
      2.2,
      label,
      'middle',
      angle,
    );
  }

  polygon(points: ReadonlyArray<Vec2>, cssClass: string): void {
    this.parts.push(
      `<polygon points="${points.map((point) => this.map(point).map(n).join(',')).join(' ')}" class="${cssClass}"/>`,
    );
  }
}

export const mmText = (value: number): string => String(Math.round(value));

export function scheduleTable(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  x: number,
  y: number,
): string {
  const widths = [14, 14, 20, 14, 14, 26, 18];
  const headers = ['Plate', 'Grid', 'Bolts', 'Embed.', 'Proj.', 'Plate mm', 'TOC / grout'];
  const parts = [`<g id="bolt-schedule">`];
  parts.push(
    `<text x="${n(x)}" y="${n(y)}" font-size="3" text-anchor="start">Anchor bolt schedule (mm)</text>`,
  );
  const all = [headers, ...rows];
  all.forEach((row, rowIndex) => {
    const top = y + 2 + rowIndex * ROW_HEIGHT;
    let left = x;
    row.forEach((cell, column) => {
      const cellWidth = widths[column] as number;
      const cssClass = rowIndex === 0 ? 'frame' : 'frame-thin';
      parts.push(
        `<rect x="${n(left)}" y="${n(top)}" width="${cellWidth}" height="${ROW_HEIGHT}" class="${cssClass}"/>`,
        `<text x="${n(left + 1)}" y="${n(top + 2.8)}" font-size="2" text-anchor="start">${escapeXml(cell)}</text>`,
      );
      left += cellWidth;
    });
  });
  parts.push(`</g>`);
  return parts.join('');
}
