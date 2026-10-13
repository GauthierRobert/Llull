/**
 * Small SVG builders for the road drawings (long section, cross sections). Text is XML-escaped.
 * @layer domain-aec/civil
 * @pure
 */

import { escapeXml } from '@lib/escapeXml';
import { n, svgPoints } from '../../shared/sheetFrame';
import { niceStep } from '@lib/niceStep';

type Point = readonly [number, number];

/** Long-section plot frame shared by road and drainage profiles (SVG user units). */
export const PLOT_LEFT = 90;
export const PLOT_TOP = 60;
export const PLOT_ROW_HEIGHT = 16;
export const PLOT_MAX_WIDTH = 1000;

export interface TextStyle {
  readonly size?: number;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly fill?: string;
  readonly weight?: 'bold' | 'normal';
  readonly rotate?: number;
}

export function svgText(x: number, y: number, content: string, style: TextStyle = {}): string {
  const rotate = style.rotate ? ` transform="rotate(${n(style.rotate)} ${n(x)} ${n(y)})"` : '';
  return (
    `<text x="${n(x)}" y="${n(y)}" font-family="monospace" font-size="${style.size ?? 10}" ` +
    `text-anchor="${style.anchor ?? 'start'}" fill="${style.fill ?? '#222'}"` +
    `${style.weight === 'bold' ? ' font-weight="bold"' : ''}${rotate}>${escapeXml(content)}</text>`
  );
}

export function svgLine(a: Point, b: Point, stroke = '#999', width = 1, dash?: string): string {
  return (
    `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" ` +
    `stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  );
}

export function svgPolyline(points: ReadonlyArray<Point>, stroke: string, width = 1.5): string {
  const list = svgPoints(points);
  return `<polyline points="${list}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
}

export function svgRect(
  x: number,
  y: number,
  w: number,
  h: number,
  stroke = '#444',
  fill = 'none',
): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" stroke="${stroke}" fill="${fill}"/>`;
}

export function svgPolygon(points: ReadonlyArray<Point>, fill: string): string {
  const list = svgPoints(points);
  return `<polygon points="${list}" fill="${fill}" fill-opacity="0.35" stroke="none"/>`;
}

export function svgDocument(width: number, height: number, body: ReadonlyArray<string>): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" ` +
    `viewBox="0 0 ${n(width)} ${n(height)}"><rect width="100%" height="100%" fill="#fff"/>` +
    `${body.join('')}</svg>`
  );
}

/** Vertical extent of a long-section plot: `rangeM` of `levels` padded 10% (min 0.5 m) each side, and the top level `zTop`. */
export function levelFrame(levels: readonly number[]): { rangeM: number; zTop: number } {
  const gridMin = Math.min(...levels);
  const gridMax = Math.max(...levels);
  const pad = Math.max((gridMax - gridMin) * 0.1, 0.5);
  return { rangeM: gridMax - gridMin + 2 * pad, zTop: gridMax + pad };
}

/** Horizontal level gridlines with right-aligned level labels, appended to `body`. */
export function pushLevelGrid(
  body: string[],
  left: number,
  plotWidth: number,
  y: (z: number) => number,
  zTop: number,
  rangeM: number,
  vScale: number,
): void {
  const zStep = niceStep(28 / vScale);
  for (let z = Math.ceil((zTop - rangeM) / zStep) * zStep; z <= zTop; z += zStep) {
    body.push(svgLine([left, y(z)], [left + plotWidth, y(z)], '#e2e2e2'));
    body.push(svgText(left - 6, y(z) + 3, z.toFixed(2), { anchor: 'end', size: 9 }));
  }
}

/** Table-band row labels (left of the plot) and row separators, appended to `body`. */
export function pushTableLabels(
  body: string[],
  labels: readonly string[],
  left: number,
  plotWidth: number,
  bandTop: number,
  rowHeight: number,
): void {
  labels.forEach((label, row) => {
    body.push(
      svgText(left - 6, bandTop + row * rowHeight + 12, label, {
        anchor: 'end',
        size: 9,
        weight: 'bold',
      }),
    );
    const rule = bandTop + (row + 1) * rowHeight;
    body.push(svgLine([left, rule], [left + plotWidth, rule], '#ccc'));
  });
}
