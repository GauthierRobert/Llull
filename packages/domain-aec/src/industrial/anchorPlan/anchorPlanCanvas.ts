/**
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import { n, svgPoints, svgText, type Viewport } from '../../shared/sheetFrame';
import { paperDimension, svgLine } from '../../shared/drawingSvg';
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

  line(a: Vec2, b: Vec2, cssClass: string): void {
    this.parts.push(svgLine(a, b, cssClass));
  }

  text(
    at: Vec2,
    size: number,
    content: string,
    anchor: 'start' | 'middle' | 'end' = 'middle',
    rotation = 0,
  ): void {
    this.parts.push(svgText(at[0], at[1], size, anchor, content, rotation));
  }

  /** Aligned dimension between two model points, drawn `side` paper-mm off the measured line. */
  dimension(a: Vec2, b: Vec2, side: number, label: string): void {
    this.parts.push(...paperDimension(this.map(a), this.map(b), side, label, 2.2));
  }

  polygon(points: ReadonlyArray<Vec2>, cssClass: string): void {
    this.parts.push(
      `<polygon points="${svgPoints(points.map((point) => this.map(point)))}" class="${cssClass}"/>`,
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
  parts.push(svgText(x, y, 3, 'start', 'Anchor bolt schedule (mm)'));
  const all = [headers, ...rows];
  all.forEach((row, rowIndex) => {
    const top = y + 2 + rowIndex * ROW_HEIGHT;
    let left = x;
    row.forEach((cell, column) => {
      const cellWidth = widths[column] as number;
      const cssClass = rowIndex === 0 ? 'frame' : 'frame-thin';
      parts.push(
        `<rect x="${n(left)}" y="${n(top)}" width="${cellWidth}" height="${ROW_HEIGHT}" class="${cssClass}"/>`,
        svgText(left + 1, top + 2.8, 2, 'start', cell),
      );
      left += cellWidth;
    });
  });
  parts.push(`</g>`);
  return parts.join('');
}
