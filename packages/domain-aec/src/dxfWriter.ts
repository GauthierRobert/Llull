/**
 * @layer domain-aec
 */

import type { DocumentUnit, Vec2 } from '@core/model/types';
import { hatchSegments } from '@lib/hatch';
import { triangulatePolygon } from '@lib/triangulate';
import { DIMENSION_LAYER, type PlanFill, type PlanPrimitive } from './planModel';

/** AutoCAD $INSUNITS codes. */
export const INSUNITS: Readonly<Record<DocumentUnit, number>> = {
  in: 1,
  ft: 2,
  mm: 4,
  cm: 5,
  m: 6,
};

/** AutoCAD Color Index per standard layer. */
const LAYER_COLOR: Readonly<Record<string, number>> = {
  'A-WALL': 7,
  'A-DOOR': 30,
  'A-GLAZ': 5,
  'S-GRID': 1,
  'S-COLS': 8,
  'S-BEAM': 4,
  'S-SLAB': 9,
  'A-FLOR-STRS': 6,
  'A-AREA': 3,
  [DIMENSION_LAYER]: 2,
};

export const HIDDEN_LAYERS: ReadonlySet<string> = new Set(['S-BEAM']);

/** DXF-safe layer name (R12: letters, digits, $, -, _). */
export function dxfLayerName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9$_-]/g, '_');
  return cleaned === '' ? '0' : cleaned;
}

/** Encodes non-ASCII characters as AutoCAD \U+XXXX escapes. */
export function dxfText(content: string): string {
  return [...content.replace(/[\r\n]+/g, ' ')]
    .map((character) => {
      const code = character.codePointAt(0) ?? 63;
      return code < 128 ? character : `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    })
    .join('');
}

export const fmt = (value: number): string => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

export class DxfWriter {
  readonly lines: string[] = [];
  readonly layers = new Map<string, number>();
  entityCount = 0;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  /** Extents of every point written so far ([0,0,0,0] when empty). */
  bounds(): readonly [number, number, number, number] {
    return Number.isFinite(this.minX) ? [this.minX, this.minY, this.maxX, this.maxY] : [0, 0, 0, 0];
  }

  private pair(code: number, value: string | number): void {
    this.lines.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }

  private start(type: string, layer: string): void {
    const name = dxfLayerName(layer);
    if (!this.layers.has(name))
      this.layers.set(name, LAYER_COLOR[name] ?? (name.endsWith('-PATT') ? 8 : 7));
    this.pair(0, type);
    this.pair(8, name);
    this.entityCount += 1;
  }

  private point(base: number, [x, y]: Vec2): void {
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
    this.pair(base, x);
    this.pair(base + 10, y);
    this.pair(base + 20, 0);
  }

  line(layer: string, a: Vec2, b: Vec2): void {
    this.start('LINE', layer);
    this.point(10, a);
    this.point(11, b);
  }

  circle(layer: string, center: Vec2, radius: number): void {
    this.start('CIRCLE', layer);
    this.point(10, center);
    this.pair(40, radius);
  }

  arc(layer: string, center: Vec2, radius: number, startAngle: number, endAngle: number): void {
    this.start('ARC', layer);
    this.point(10, center);
    this.pair(40, radius);
    this.pair(50, (startAngle * 180) / Math.PI);
    this.pair(51, (endAngle * 180) / Math.PI);
  }

  text(
    layer: string,
    at: Vec2,
    height: number,
    content: string,
    align: 'left' | 'center' | 'right',
    rotation = 0,
  ): void {
    this.start('TEXT', layer);
    this.point(10, at);
    this.pair(40, height);
    this.pair(1, dxfText(content));
    if (rotation !== 0) this.pair(50, (rotation * 180) / Math.PI);
    if (align !== 'left') {
      this.pair(72, align === 'center' ? 1 : 2);
      this.point(11, at);
    }
  }

  polyline(layer: string, points: ReadonlyArray<Vec2>, closed: boolean): void {
    this.start('POLYLINE', layer);
    this.pair(66, 1);
    this.pair(70, closed ? 1 : 0);
    this.point(10, [0, 0]);
    const name = dxfLayerName(layer);
    for (const point of points) {
      this.pair(0, 'VERTEX');
      this.pair(8, name);
      this.point(10, point);
    }
    this.pair(0, 'SEQEND');
    this.pair(8, name);
  }

  /** Filled triangle (R12 SOLID; the fourth corner repeats the third). */
  solid(layer: string, a: Vec2, b: Vec2, c: Vec2): void {
    this.start('SOLID', layer);
    this.point(10, a);
    this.point(11, b);
    this.point(12, c);
    this.point(13, c);
  }

  point2(layer: string, at: Vec2): void {
    this.start('POINT', layer);
    this.point(10, at);
  }
}

function writeDimension(
  writer: DxfWriter,
  primitive: Extract<PlanPrimitive, { type: 'dimension' }>,
): void {
  const dx = primitive.b[0] - primitive.a[0];
  const dy = primitive.b[1] - primitive.a[1];
  const length = Math.hypot(dx, dy) || 1;
  const normal: Vec2 = [dy / length, -dx / length];
  const shift = (point: Vec2, distance: number): Vec2 => [
    point[0] + normal[0] * distance,
    point[1] + normal[1] * distance,
  ];
  const a = shift(primitive.a, primitive.offset);
  const b = shift(primitive.b, primitive.offset);
  const tick = primitive.offset * 0.12;
  writer.line(
    primitive.layer,
    shift(primitive.a, primitive.offset * 0.15),
    shift(primitive.a, primitive.offset * 1.1),
  );
  writer.line(
    primitive.layer,
    shift(primitive.b, primitive.offset * 0.15),
    shift(primitive.b, primitive.offset * 1.1),
  );
  writer.line(primitive.layer, a, b);
  for (const end of [a, b]) {
    writer.line(primitive.layer, [end[0] - tick, end[1] - tick], [end[0] + tick, end[1] + tick]);
  }
  let angle = Math.atan2(dy, dx);
  if (angle > Math.PI / 2 + 1e-9 || angle <= -Math.PI / 2 + 1e-9) angle += Math.PI;
  const middle: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const lift = -primitive.offset * 0.2;
  writer.text(
    primitive.layer,
    [middle[0] - Math.sin(angle) * lift, middle[1] + Math.cos(angle) * lift],
    primitive.offset * 0.25,
    primitive.label,
    'center',
    angle,
  );
}

/** Pattern layer of a cut layer, e.g. A-WALL → A-WALL-PATT (AIA / NCS). */
const patternLayer = (layer: string): string => `${layer}-PATT`;

/** ANSI31 (45° lines) for concrete / masonry, SOLID triangles for steel. */
function writeFill(
  writer: DxfWriter,
  layer: string,
  outer: ReadonlyArray<Vec2>,
  holes: ReadonlyArray<ReadonlyArray<Vec2>>,
  fill: PlanFill,
  hatchSpacing: number,
): void {
  if (fill === 'hatch') {
    for (const [a, b] of hatchSegments([outer, ...holes], Math.PI / 4, hatchSpacing)) {
      writer.line(patternLayer(layer), a, b);
    }
    return;
  }
  const { vertices, triangles } = triangulatePolygon(outer, holes);
  for (const [i, j, k] of triangles) {
    writer.solid(
      patternLayer(layer),
      vertices[i] as Vec2,
      vertices[j] as Vec2,
      vertices[k] as Vec2,
    );
  }
}

export function writePrimitive(
  writer: DxfWriter,
  primitive: PlanPrimitive,
  hatchSpacing: number,
): void {
  switch (primitive.type) {
    case 'polygon':
      writer.polyline(primitive.layer, primitive.points, true);
      if (primitive.fill !== undefined) {
        writeFill(
          writer,
          primitive.layer,
          primitive.points,
          primitive.holes ?? [],
          primitive.fill,
          hatchSpacing,
        );
      }
      return;
    case 'polyline':
      writer.polyline(primitive.layer, primitive.points, false);
      return;
    case 'line':
      writer.line(primitive.layer, primitive.a, primitive.b);
      return;
    case 'arc':
      writer.arc(
        primitive.layer,
        primitive.center,
        primitive.radius,
        primitive.startAngle,
        primitive.endAngle,
      );
      return;
    case 'circle':
      writer.circle(primitive.layer, primitive.center, primitive.radius);
      if (primitive.style === 'cut') {
        const ring = Array.from({ length: 32 }, (_, index): Vec2 => {
          const angle = (index / 32) * Math.PI * 2;
          return [
            primitive.center[0] + primitive.radius * Math.cos(angle),
            primitive.center[1] + primitive.radius * Math.sin(angle),
          ];
        });
        writeFill(writer, primitive.layer, ring, [], 'hatch', hatchSpacing);
      }
      return;
    case 'text':
      writer.text(primitive.layer, primitive.at, primitive.height, primitive.content, 'center');
      return;
    case 'dimension':
      writeDimension(writer, primitive);
      return;
  }
}
