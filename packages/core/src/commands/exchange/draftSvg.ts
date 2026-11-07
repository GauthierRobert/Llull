/**
 * Drafting shapes as one SVG document in millimetres (the mapping behind `export_svg`). Y is flipped (SVG is y-down); arcs are `A` commands
 * (exact), ellipses two half-ellipse `A` commands, splines cubic Béziers (exact), hatches `<pattern>` fills, text `<text>`.
 */

import type { Vec2 } from '../../model/vectors';
import { escapeXml } from '../../lib/escapeXml';
import { positiveSweep, toDegrees } from '../../lib/angle';
import type { DraftItem, DraftShape } from './draftExport';

export interface SvgOptions {
  /** Millimetres per document unit. */
  readonly unitMm: number;
  /** Blank border around the drawing, mm. */
  readonly marginMm: number;
  /** Stroke width of every line, mm. */
  readonly lineWeightMm: number;
}

/** Cap height of the SVG font as a fraction of its `font-size` (DXF / llull text heights are cap heights). */
export const CAP_HEIGHT_RATIO = 0.72;
/** Line pitch of multi-line text, in font sizes. */
const LINE_PITCH = 1.2;
const FULL_TURN = 2 * Math.PI;
/** Samples used to bound an ellipse and a Bézier segment. */
const BOUND_SAMPLES = 32;
/** Mean glyph width in text heights (bounds estimate only). */
const GLYPH_WIDTH = 0.6;

/** SVG number text: 6 decimals at most, no exponent, no negative zero. */
export const svgNumber = (value: number): string => String(Math.round(value * 1e6) / 1e6 + 0);

const pair = (point: Vec2): string => `${svgNumber(point[0])} ${svgNumber(point[1])}`;

/** SVG path of an exact circular arc from `start` for `sweep` radians (counter-clockwise on paper), as written in y-down coordinates. */
export function arcPath(center: Vec2, radius: number, start: number, end: number): string {
  const sweep = positiveSweep(end - start);
  const at = (angle: number): Vec2 => [center[0] + radius * Math.cos(angle), -(center[1] + radius * Math.sin(angle))];
  const r = `${svgNumber(radius)} ${svgNumber(radius)}`;
  if (sweep >= FULL_TURN - 1e-12) return `M ${pair(at(start))} A ${r} 0 0 0 ${pair(at(start + Math.PI))} A ${r} 0 0 0 ${pair(at(start))}`;
  return `M ${pair(at(start))} A ${r} 0 ${sweep > Math.PI ? 1 : 0} 0 ${pair(at(end))}`;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

function grow(box: Box, [x, y]: Vec2): void {
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
}

/** Extent of a shape in document units (world xy, y up). */
function growShape(box: Box, shape: DraftShape): void {
  switch (shape.kind) {
    case 'line':
      grow(box, shape.a);
      grow(box, shape.b);
      return;
    case 'polyline':
    case 'point':
      for (const point of shape.kind === 'point' ? [shape.at] : shape.points) grow(box, point);
      return;
    case 'circle':
      grow(box, [shape.center[0] - shape.radius, shape.center[1] - shape.radius]);
      grow(box, [shape.center[0] + shape.radius, shape.center[1] + shape.radius]);
      return;
    case 'arc': {
      const sweep = positiveSweep(shape.end - shape.start);
      const angles = [
        shape.start,
        shape.start + sweep,
        ...[0, 1, 2, 3]
          .map((q) => (q * Math.PI) / 2)
          .flatMap((q) => {
            const offset = positiveSweep(q - shape.start) % FULL_TURN;
            return offset <= sweep ? [shape.start + offset] : [];
          }),
      ];
      for (const angle of angles)
        grow(box, [shape.center[0] + shape.radius * Math.cos(angle), shape.center[1] + shape.radius * Math.sin(angle)]);
      return;
    }
    case 'ellipse': {
      const minor: Vec2 = [-shape.major[1] * shape.ratio, shape.major[0] * shape.ratio];
      for (let i = 0; i < BOUND_SAMPLES * 2; i++) {
        const t = (i / (BOUND_SAMPLES * 2)) * FULL_TURN;
        grow(box, [
          shape.center[0] + shape.major[0] * Math.cos(t) + minor[0] * Math.sin(t),
          shape.center[1] + shape.major[1] * Math.cos(t) + minor[1] * Math.sin(t),
        ]);
      }
      return;
    }
    case 'spline':
      for (const [p0, p1, p2, p3] of shape.beziers)
        for (let i = 0; i <= BOUND_SAMPLES; i++) {
          const [t, u] = [i / BOUND_SAMPLES, 1 - i / BOUND_SAMPLES];
          const mix = (axis: 0 | 1): number =>
            u * u * u * p0[axis] + 3 * u * u * t * p1[axis] + 3 * u * t * t * p2[axis] + t * t * t * p3[axis];
          grow(box, [mix(0), mix(1)]);
        }
      return;
    case 'text': {
      const widest = Math.max(...shape.content.split(/\r?\n/).map((line) => line.length)) * shape.height * GLYPH_WIDTH;
      const left = shape.anchor === 'left' ? 0 : shape.anchor === 'center' ? -widest / 2 : -widest;
      const [c, s] = [Math.cos(shape.rotation), Math.sin(shape.rotation)];
      const lines = shape.content.split(/\r?\n/).length;
      for (const [u, v] of [
        [left, shape.height],
        [left + widest, shape.height],
        [left, -(lines - 1) * shape.height * LINE_PITCH],
        [left + widest, 0],
      ] as const)
        grow(box, [shape.at[0] + u * c - v * s, shape.at[1] + u * s + v * c]);
      return;
    }
    case 'region':
      for (const loop of shape.loops) for (const point of loop) grow(box, point);
  }
}

class Patterns {
  readonly defs: string[] = [];
  private readonly ids = new Map<string, string>();

  constructor(private readonly options: SvgOptions) {}

  /** `url(#hatch-n)` of a line pattern, defined once per (angle, spacing, colour, crossing). */
  url(angle: number, spacing: number, cross: boolean, color: string): string {
    const key = `${angle}|${spacing}|${cross}|${color}`;
    const known = this.ids.get(key);
    if (known !== undefined) return `url(#${known})`;
    const id = `hatch-${this.ids.size + 1}`;
    this.ids.set(key, id);
    const size = spacing * this.options.unitMm;
    const half = svgNumber(size / 2);
    const line = (x1: string, y1: string, x2: string, y2: string): string => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    const strokes = [line('0', half, svgNumber(size), half), ...(cross ? [line(half, '0', half, svgNumber(size))] : [])].join('');
    this.defs.push(
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${svgNumber(size)}" height="${svgNumber(size)}" patternTransform="rotate(${svgNumber(-toDegrees(angle))})" ` +
        `stroke="${color}" stroke-width="${svgNumber(this.options.lineWeightMm)}" fill="none">${strokes}</pattern>`,
    );
    return `url(#${id})`;
  }
}

function textElement(shape: Extract<DraftShape, { kind: 'text' }>, color: string, unitMm: number): string {
  const [x, y] = [shape.at[0] * unitMm, -shape.at[1] * unitMm];
  const size = (shape.height * unitMm) / CAP_HEIGHT_RATIO;
  const anchor = shape.anchor === 'left' ? 'start' : shape.anchor === 'center' ? 'middle' : 'end';
  const lines = shape.content.split(/\r?\n/);
  const body =
    lines.length === 1
      ? escapeXml(shape.content)
      : lines
          .map(
            (line, index) => `<tspan x="${svgNumber(x)}" dy="${index === 0 ? 0 : svgNumber(size * LINE_PITCH)}">${escapeXml(line)}</tspan>`,
          )
          .join('');
  const turn = shape.rotation === 0 ? '' : ` transform="rotate(${svgNumber(-toDegrees(shape.rotation))} ${svgNumber(x)} ${svgNumber(y)})"`;
  return `<text x="${svgNumber(x)}" y="${svgNumber(y)}" font-size="${svgNumber(size)}" text-anchor="${anchor}" fill="${color}" stroke="none"${turn}>${body}</text>`;
}

/** Path data of closed loops (document units, y-up) as millimetres, y-down. */
const loopsPath = (loops: ReadonlyArray<ReadonlyArray<Vec2>>, to: (point: Vec2) => Vec2): string =>
  loops.map((loop) => `M ${loop.map((point) => pair(to(point))).join(' L ')} Z`).join(' ');

/** One element of a shape; `color` is the stroke / fill colour, `paint` an attribute string to add (stroke override). */
function shapeElement(item: DraftItem, options: SvgOptions, patterns: Patterns, paint: string): string {
  const { shape, color } = item;
  const mm = options.unitMm;
  const to = (point: Vec2): Vec2 => [point[0] * mm, -point[1] * mm];
  const scaled = (point: Vec2): Vec2 => [point[0] * mm, point[1] * mm];
  switch (shape.kind) {
    case 'line':
      return `<line x1="${svgNumber(to(shape.a)[0])}" y1="${svgNumber(to(shape.a)[1])}" x2="${svgNumber(to(shape.b)[0])}" y2="${svgNumber(to(shape.b)[1])}"${paint}/>`;
    case 'polyline':
      return `<${shape.closed ? 'polygon' : 'polyline'} points="${shape.points.map((point) => pair(to(point))).join(' ')}"${paint}/>`;
    case 'circle':
      return `<circle cx="${svgNumber(to(shape.center)[0])}" cy="${svgNumber(to(shape.center)[1])}" r="${svgNumber(shape.radius * mm)}"${paint}/>`;
    case 'arc':
      return `<path d="${arcPath(scaled(shape.center), shape.radius * mm, shape.start, shape.end)}"${paint}/>`;
    case 'ellipse': {
      const [center, tip] = [to(shape.center), to([shape.center[0] + shape.major[0], shape.center[1] + shape.major[1]])];
      const opposite: Vec2 = [2 * center[0] - tip[0], 2 * center[1] - tip[1]];
      const rx = Math.hypot(shape.major[0], shape.major[1]) * mm;
      const radii = `${svgNumber(rx)} ${svgNumber(rx * shape.ratio)} ${svgNumber(toDegrees(Math.atan2(tip[1] - center[1], tip[0] - center[0])))}`;
      return `<path d="M ${pair(tip)} A ${radii} 0 0 ${pair(opposite)} A ${radii} 0 0 ${pair(tip)} Z"${paint}/>`;
    }
    case 'spline': {
      const [first] = shape.beziers;
      if (first === undefined) return '';
      const curves = shape.beziers.map(([, c1, c2, end]) => `C ${pair(to(c1))} ${pair(to(c2))} ${pair(to(end))}`).join(' ');
      return `<path d="M ${pair(to(first[0]))} ${curves}${shape.closed ? ' Z' : ''}"${paint}/>`;
    }
    case 'point':
      return `<circle cx="${svgNumber(to(shape.at)[0])}" cy="${svgNumber(to(shape.at)[1])}" r="${svgNumber(options.lineWeightMm)}" fill="${color}" stroke="none"/>`;
    case 'text':
      return textElement(shape, color, mm);
    case 'region': {
      const fill =
        shape.hatch === null
          ? 'none'
          : shape.hatch.pattern === 'solid'
            ? color
            : patterns.url(shape.hatch.angle, shape.hatch.spacing, shape.hatch.pattern === 'cross', color);
      return `<path fill-rule="evenodd" fill="${fill}" d="${loopsPath(shape.loops, to)}"${paint}/>`;
    }
  }
}

export interface DraftSvg {
  readonly svg: string;
  /** [minX, minY, width, height] in mm. */
  readonly viewBox: readonly [number, number, number, number];
  readonly widthMm: number;
  readonly heightMm: number;
  readonly elementCount: number;
}

/** The SVG of `items`: one `<g>` per layer (stroke = the layer colour, black without one), the viewBox fitted to the drawing plus the margin. */
export function renderDraftSvg(items: readonly DraftItem[], options: SvgOptions): DraftSvg {
  const box = emptyBox();
  for (const item of items) growShape(box, item.shape);
  const mm = options.unitMm;
  const minX = box.minX * mm - options.marginMm;
  const minY = -box.maxY * mm - options.marginMm;
  const widthMm = Math.max((box.maxX - box.minX) * mm + 2 * options.marginMm, 1);
  const heightMm = Math.max((box.maxY - box.minY) * mm + 2 * options.marginMm, 1);
  const patterns = new Patterns(options);
  const byLayer = new Map<string, DraftItem[]>();
  for (const item of items) byLayer.set(item.layerName, [...(byLayer.get(item.layerName) ?? []), item]);
  const groups = [...byLayer].map(([name, layerItems], index) => {
    const first = layerItems[0] as DraftItem;
    const stroke = first.layerColor ?? '#000000';
    const elements = layerItems.map((item) => {
      const paint = item.color.toLowerCase() === stroke.toLowerCase() ? '' : ` stroke="${item.color}"`;
      return shapeElement(item, options, patterns, paint);
    });
    const hidden = first.visible ? '' : ' display="none"';
    return (
      `<g id="layer-${index + 1}" data-layer="${escapeXml(name)}" stroke="${stroke}" fill="none" stroke-width="${svgNumber(options.lineWeightMm)}" ` +
      `stroke-linecap="round" stroke-linejoin="round"${hidden}>\n${elements.join('\n')}\n</g>`
    );
  });
  const viewBox = [minX, minY, widthMm, heightMm].map((value) => Number(svgNumber(value))) as unknown as DraftSvg['viewBox'];
  const defs = patterns.defs.length > 0 ? `<defs>${patterns.defs.join('')}</defs>\n` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.map(svgNumber).join(' ')}" width="${svgNumber(widthMm)}mm" height="${svgNumber(heightMm)}mm">\n` +
    `${defs}${groups.join('\n')}\n</svg>\n`;
  return { svg, viewBox, widthMm, heightMm, elementCount: items.length };
}
