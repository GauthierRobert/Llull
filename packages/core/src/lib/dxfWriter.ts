/**
 * Generic AutoCAD R12 DXF writer: sanitised layer names, escaped text, entity methods with running extents, and the file assembly (header,
 * line types, layer table). Domain packages add their own layer colours and line types (AEC plan export, sheet-metal flat patterns).
 * @layer lib
 */

import { toDegrees } from './angle';
import type { Vec2, Vec3 } from '../model/vectors';

/** AutoCAD $INSUNITS codes by document unit. */
export const INSUNITS: Readonly<Record<'in' | 'ft' | 'mm' | 'cm' | 'm', number>> = { in: 1, ft: 2, mm: 4, cm: 5, m: 6 };

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

/** Rounds to 6 decimals; never returns -0. */
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

export const fmt = (value: number): string => String(round6(value));

/** Mean character width of the R12 STANDARD font, in text heights (extents estimate only). */
const TEXT_WIDTH_PER_HEIGHT = 0.6;

/** Generic AutoCAD R12 entity writer (LINE, CIRCLE, ARC, TEXT, POLYLINE, SOLID, POINT, 3DFACE); `assembleDxf` wraps it in a file. */
export class DxfWriter {
  readonly lines: string[] = [];
  readonly layers = new Map<string, number>();
  private readonly layerNames = new Map<string, string>();
  entityCount = 0;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  /** @param layerColors AutoCAD Color Index per DXF-safe layer name (default 7, or 8 for `-PATT` layers). */
  constructor(private readonly layerColors: Readonly<Record<string, number>> = {}) {}

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
    this.layers.set(name, this.layerColors[base] ?? (base.endsWith('-PATT') ? 8 : 7));
    return name;
  }

  private start(type: string, layer: string): void {
    const name = this.layerName(layer);
    this.pair(0, type);
    this.pair(8, name);
    this.entityCount += 1;
  }

  private extend(x: number, y: number): void {
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
  }

  private point(base: number, [x, y]: Vec2, z = 0): void {
    this.extend(x, y);
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

  /** Grows the extents by the estimated box of a text line (width ≈ 0.6 × height per character), aligned and rotated about `at`. */
  private extendByTextBox(at: Vec2, height: number, content: string, align: 'left' | 'center' | 'right', rotation: number): void {
    const width = content.length * height * TEXT_WIDTH_PER_HEIGHT;
    const left = align === 'left' ? 0 : align === 'center' ? -width / 2 : -width;
    const [c, s] = [Math.cos(rotation), Math.sin(rotation)];
    for (const [u, v] of [
      [left, 0],
      [left + width, 0],
      [left, height],
      [left + width, height],
    ] as const) {
      this.extend(at[0] + u * c - v * s, at[1] + u * s + v * c);
    }
  }

  text(layer: string, at: Vec2, height: number, content: string, align: 'left' | 'center' | 'right', rotation = 0, z = 0): void {
    this.start('TEXT', layer);
    this.point(10, at, z);
    this.extendByTextBox(at, height, content, align, rotation);
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

type DxfGroup = readonly [code: number, value: string | number];

const flatten = (groups: ReadonlyArray<DxfGroup>): string[] => groups.flatMap(([code, value]) => [String(code), String(value)]);

/** An LTYPE table entry: dash lengths positive, gaps negative, in drawing units. */
export interface DxfLineType {
  readonly name: string;
  readonly description: string;
  readonly lengths: ReadonlyArray<number>;
}

// prettier-ignore
function lineTypeGroups({ name, description, lengths }: DxfLineType): DxfGroup[] {
  return [
    [0, 'LTYPE'], [2, name], [70, 0], [3, description], [72, 65], [73, lengths.length],
    [40, fmt(lengths.reduce((sum, length) => sum + Math.abs(length), 0))],
    ...lengths.map((length): DxfGroup => [49, fmt(length)]),
  ];
}

/**
 * The complete R12 file text of everything `writer` holds: header ($INSUNITS, extents), LTYPE table (CONTINUOUS + `lineTypes`), LAYER table
 * (layer 0 + the writer's layers, each drawn with `layerLineType`), then the entities.
 */
// prettier-ignore
export function assembleDxf(
  unit: keyof typeof INSUNITS,
  writer: DxfWriter,
  lineTypes: ReadonlyArray<DxfLineType> = [],
  layerLineType: (layer: string) => string = () => 'CONTINUOUS',
): string {
  const bounds = writer.bounds();
  const groups: DxfGroup[] = [
    [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1009'], [9, '$INSUNITS'], [70, INSUNITS[unit]],
    [9, '$EXTMIN'], [10, fmt(bounds[0])], [20, fmt(bounds[1])], [30, 0],
    [9, '$EXTMAX'], [10, fmt(bounds[2])], [20, fmt(bounds[3])], [30, 0],
    [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'TABLES'],
    [0, 'TABLE'], [2, 'LTYPE'], [70, lineTypes.length + 1],
    [0, 'LTYPE'], [2, 'CONTINUOUS'], [70, 0], [3, 'Solid line'], [72, 65], [73, 0], [40, '0.0'],
    ...lineTypes.flatMap(lineTypeGroups),
    [0, 'ENDTAB'],
    [0, 'TABLE'], [2, 'LAYER'], [70, writer.layers.size + 1],
    [0, 'LAYER'], [2, '0'], [70, 0], [62, 7], [6, 'CONTINUOUS'],
  ];
  for (const [name, color] of writer.layers) {
    if (name !== '0') groups.push([0, 'LAYER'], [2, name], [70, 0], [62, color], [6, layerLineType(name)]);
  }
  groups.push([0, 'ENDTAB'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES']);
  return [...flatten(groups), ...writer.lines, ...flatten([[0, 'ENDSEC'], [0, 'EOF']])].join('\n');
}
