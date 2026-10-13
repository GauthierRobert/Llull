import { toDegrees } from '@lib/angle';
import type { DocumentUnit, Vec2, Vec3 } from '@core/model/types';
import { ansi31Hatch } from '@lib/hatch';
import { sampleArc } from '@lib/arc';
import { dimensionGeometry } from '@core/geometry/dimensionGeometry';
import { triangulatePolygon } from '@lib/triangulate';
import { round } from '../../shared/numeric';
import type { DrawingFill, DrawingPrimitive } from '@core/model/drawing';
import { TECHNICAL_LAYERS } from '@core/geometry/technicalView';
import { DIMENSION_LAYER } from '../drawings/planModel';

/** AutoCAD $INSUNITS codes. */
export const INSUNITS: Readonly<Record<DocumentUnit, number>> = { in: 1, ft: 2, mm: 4, cm: 5, m: 6 };

/** AutoCAD Color Index per standard layer. */
// prettier-ignore
const LAYER_COLOR: Readonly<Record<string, number>> = {
  'A-WALL': 7, 'A-DOOR': 30, 'A-GLAZ': 5, 'S-GRID': 1, 'S-COLS': 8, 'S-BEAM': 4, 'S-SLAB': 9, 'A-FLOR-STRS': 6, 'A-AREA': 3,
  [DIMENSION_LAYER]: 2, [TECHNICAL_LAYERS.visible]: 7, [TECHNICAL_LAYERS.hidden]: 8, [TECHNICAL_LAYERS.center]: 1,
  [TECHNICAL_LAYERS.cut]: 7,
};

export const HIDDEN_LAYERS: ReadonlySet<string> = new Set(['S-BEAM', TECHNICAL_LAYERS.hidden]);
export const CENTER_LAYERS: ReadonlySet<string> = new Set(['S-GRID', TECHNICAL_LAYERS.center]);

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

export const fmt = (value: number): string => String(round(value, 6));

export class DxfWriter {
  readonly lines: string[] = [];
  readonly layers = new Map<string, number>();
  private readonly layerNames = new Map<string, string>();
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

  /**
   * R12 name of a source layer. Sources whose sanitised names collide ("A B" / "A_B") keep distinct layers: later ones get `_2`, `_3`, … in
   * first-seen order.
   */
  private layerName(layer: string): string {
    const known = this.layerNames.get(layer);
    if (known !== undefined) return known;
    const base = dxfLayerName(layer);
    const taken = new Set(this.layerNames.values());
    let name = base;
    for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`;
    this.layerNames.set(layer, name);
    this.layers.set(name, LAYER_COLOR[base] ?? (base.endsWith('-PATT') ? 8 : 7));
    return name;
  }

  private start(type: string, layer: string): void {
    const name = this.layerName(layer);
    this.pair(0, type);
    this.pair(8, name);
    this.entityCount += 1;
  }

  private point(base: number, [x, y]: Vec2, z = 0): void {
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
    this.pair(base, x);
    this.pair(base + 10, y);
    this.pair(base + 20, z);
  }

  /** Line in the horizontal plane at elevation `z` (default 0). */
  line(layer: string, a: Vec2, b: Vec2, z = 0): void {
    this.start('LINE', layer);
    this.point(10, a, z);
    this.point(11, b, z);
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
    this.pair(50, toDegrees(startAngle));
    this.pair(51, toDegrees(endAngle));
  }

  text(layer: string, at: Vec2, height: number, content: string, align: 'left' | 'center' | 'right', rotation = 0, z = 0): void {
    this.start('TEXT', layer);
    this.point(10, at, z);
    this.pair(40, height);
    this.pair(1, dxfText(content));
    if (rotation !== 0) this.pair(50, toDegrees(rotation));
    if (align !== 'left') {
      this.pair(72, align === 'center' ? 1 : 2);
      this.point(11, at, z);
    }
  }

  /** 2D polyline; `elevation` places its plane (contours keep their elevation). */
  polyline(layer: string, points: ReadonlyArray<Vec2>, closed: boolean, elevation = 0): void {
    this.start('POLYLINE', layer);
    this.pair(66, 1);
    this.pair(70, closed ? 1 : 0);
    this.point(10, [0, 0], elevation);
    const name = this.layerName(layer);
    for (const point of points) {
      this.pair(0, 'VERTEX');
      this.pair(8, name);
      this.point(10, point, elevation);
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

  point2(layer: string, at: Vec2, z = 0): void {
    this.start('POINT', layer);
    this.point(10, at, z);
  }

  /** Triangular 3D face (the fourth corner repeats the third), e.g. one TIN triangle. */
  face3d(layer: string, a: Vec3, b: Vec3, c: Vec3): void {
    this.start('3DFACE', layer);
    for (const [base, corner] of [
      [10, a],
      [11, b],
      [12, c],
      [13, c],
    ] as const) {
      this.point(base, [corner[0], corner[1]], corner[2]);
    }
  }
}

function writeDimension(writer: DxfWriter, primitive: Extract<DrawingPrimitive, { type: 'dimension' }>): void {
  const { segments, label } = dimensionGeometry(primitive);
  for (const [a, b] of segments) writer.line(primitive.layer, a, b);
  writer.text(primitive.layer, label.at, label.height, primitive.label, 'center', label.angle);
}

/** Pattern layer of a cut layer, e.g. A-WALL → A-WALL-PATT (AIA / NCS). */
const patternLayer = (layer: string): string => `${layer}-PATT`;

/** ANSI31 (45° lines) for concrete / masonry, SOLID triangles for steel. */
function writeFill(
  writer: DxfWriter,
  layer: string,
  outer: ReadonlyArray<Vec2>,
  holes: ReadonlyArray<ReadonlyArray<Vec2>>,
  fill: DrawingFill,
  hatchSpacing: number,
): void {
  if (fill === 'hatch') {
    for (const [a, b] of ansi31Hatch([outer, ...holes], hatchSpacing)) {
      writer.line(patternLayer(layer), a, b);
    }
    return;
  }
  const { vertices, triangles } = triangulatePolygon(outer, holes);
  for (const [i, j, k] of triangles) {
    writer.solid(patternLayer(layer), vertices[i] as Vec2, vertices[j] as Vec2, vertices[k] as Vec2);
  }
}

export function writePrimitive(writer: DxfWriter, primitive: DrawingPrimitive, hatchSpacing: number): void {
  switch (primitive.type) {
    case 'polygon':
      writer.polyline(primitive.layer, primitive.points, true);
      if (primitive.fill !== undefined) {
        writeFill(writer, primitive.layer, primitive.points, primitive.holes ?? [], primitive.fill, hatchSpacing);
      }
      return;
    case 'polyline':
      writer.polyline(primitive.layer, primitive.points, false);
      return;
    case 'line':
      writer.line(primitive.layer, primitive.a, primitive.b);
      return;
    case 'arc':
      writer.arc(primitive.layer, primitive.center, primitive.radius, primitive.startAngle, primitive.endAngle);
      return;
    case 'circle':
      writer.circle(primitive.layer, primitive.center, primitive.radius);
      if (primitive.fill !== undefined) {
        const ring = sampleArc(primitive.center, primitive.radius, 0, Math.PI * 2, 32);
        writeFill(writer, primitive.layer, ring, [], primitive.fill, hatchSpacing);
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
