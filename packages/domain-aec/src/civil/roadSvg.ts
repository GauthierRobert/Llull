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
