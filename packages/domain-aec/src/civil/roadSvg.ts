/**
 * Small SVG builders for the road drawings (long section, cross sections). Text is XML-escaped.
 * @layer domain-aec/civil
 * @pure
 */

import { escapeXml } from '@lib/escapeXml';

type Point = readonly [number, number];

export const num = (value: number): string => String(Number(value.toFixed(2)));

export interface TextStyle {
  readonly size?: number;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly fill?: string;
  readonly weight?: 'bold' | 'normal';
  readonly rotate?: number;
}

export function svgText(x: number, y: number, content: string, style: TextStyle = {}): string {
  const rotate = style.rotate
    ? ` transform="rotate(${num(style.rotate)} ${num(x)} ${num(y)})"`
    : '';
  return (
    `<text x="${num(x)}" y="${num(y)}" font-family="monospace" font-size="${style.size ?? 10}" ` +
    `text-anchor="${style.anchor ?? 'start'}" fill="${style.fill ?? '#222'}"` +
    `${style.weight === 'bold' ? ' font-weight="bold"' : ''}${rotate}>${escapeXml(content)}</text>`
  );
}

export function svgLine(a: Point, b: Point, stroke = '#999', width = 1, dash?: string): string {
  return (
    `<line x1="${num(a[0])}" y1="${num(a[1])}" x2="${num(b[0])}" y2="${num(b[1])}" ` +
    `stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  );
}

export function svgPolyline(points: ReadonlyArray<Point>, stroke: string, width = 1.5): string {
  const list = points.map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
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
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" stroke="${stroke}" fill="${fill}"/>`;
}

export function svgPolygon(points: ReadonlyArray<Point>, fill: string): string {
  const list = points.map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
  return `<polygon points="${list}" fill="${fill}" fill-opacity="0.35" stroke="none"/>`;
}

export function svgDocument(width: number, height: number, body: ReadonlyArray<string>): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" ` +
    `viewBox="0 0 ${num(width)} ${num(height)}"><rect width="100%" height="100%" fill="#fff"/>` +
    `${body.join('')}</svg>`
  );
}

const NICE = [1, 2, 5, 10];

/** Smallest 1-2-5 step (times a power of ten) that is at least `minimum`. */
export function niceStep(minimum: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(minimum, 1e-9)));
  return (
    (NICE.map((n) => n * power).find((step) => step >= minimum - 1e-12) as number) ?? power * 10
  );
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
