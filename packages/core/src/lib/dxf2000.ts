/**
 * AutoCAD R2000 (AC1015) ASCII DXF writer for 2D drafting: handles, subclass markers, the symbol tables, LWPOLYLINE, ELLIPSE, SPLINE, MTEXT
 * and HATCH, true colours (420), layer visibility / lock and `LLULL` extended data. Numbers are written at full precision.
 * @layer lib
 */

import { toDegrees } from './angle';
import { hexToAci } from './dxfUnits';
import { type INSUNITS, dxfText } from './dxfWriter';
import { LLULL_APP } from './dxfReadShapes';
import { encodeTextLiterals } from './dxfRecord';
import type { Vec2 } from '../model/vectors';
import { type DxfLayerDef, type Group, assembleFile, flatten, hexColor } from './dxf2000File';

const FORBIDDEN_IN_NAMES = '<>/\\":;?*|=`';

/** DXF layer name: `< > / \ " : ; ? * | = \`` and control characters become `_`, non-ASCII becomes `\U+XXXX`; `0` when nothing is left. */
function dxfLayerName2000(name: string): string {
  const safe = [...name].map((ch) => (FORBIDDEN_IN_NAMES.includes(ch) || ch.charCodeAt(0) < 32 ? '_' : ch)).join('');
  const cleaned = dxfText(safe.slice(0, 255));
  return cleaned.trim() === '' ? '0' : cleaned;
}

/** Per-entity attributes: the DXF layer name (from `declareLayer`) and a true colour (null = by layer). */
export interface DxfStyle {
  readonly layer: string;
  readonly color: string | null;
}

/** Extended data of the `LLULL` application: a kind tag, integers and points (read back by `import_dxf`). */
export interface DxfXdata {
  readonly tag: string;
  readonly ints?: readonly number[];
  readonly points?: ReadonlyArray<readonly [number, number, number]>;
}

/** Hatch fill: solid, or parallel lines at `angle` (radians) `spacing` apart, optionally crossed at +90°. */
export type DxfHatchFill =
  | { readonly kind: 'solid' }
  | { readonly kind: 'lines'; readonly angle: number; readonly spacing: number; readonly cross: boolean };

/** Mean character width of the STANDARD font in text heights (extents estimate only). */
const TEXT_WIDTH_PER_HEIGHT = 0.6;
const ENTITY_HANDLE_BASE = 0x10000;

export class Dxf2000Writer {
  private readonly lines: string[] = [];
  private readonly layerDefs = new Map<string, DxfLayerDef>();
  private readonly sourceLayers = new Map<string, string>();
  private readonly taken = new Set<string>();
  private handleCounter = ENTITY_HANDLE_BASE;
  private box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  entityCount = 0;

  /** Extents of every point written so far ([0,0,0,0] when empty). */
  bounds(): readonly [number, number, number, number] {
    return Number.isFinite(this.box[0]) ? this.box : [0, 0, 0, 0];
  }

  /** DXF layer names in table order. */
  get layerNames(): string[] {
    return [...this.layerDefs.keys()];
  }

  /** The DXF layer of `source`, created with `def` on first use. Names that differ only by case or by sanitising get `_2`, `_3` suffixes. */
  declareLayer(source: string, def: DxfLayerDef): string {
    const known = this.sourceLayers.get(source);
    if (known !== undefined) return known;
    const base = dxfLayerName2000(source);
    let name = base;
    for (let suffix = 2; this.taken.has(name.toUpperCase()); suffix++) name = `${base}_${suffix}`;
    this.taken.add(name.toUpperCase());
    this.sourceLayers.set(source, name);
    this.layerDefs.set(name, def);
    return name;
  }

  private extend(x: number, y: number): void {
    this.box = [Math.min(this.box[0], x), Math.min(this.box[1], y), Math.max(this.box[2], x), Math.max(this.box[3], y)];
  }

  private xy(base: number, [x, y]: Vec2, z: number): Group[] {
    this.extend(x, y);
    return [
      [base, x],
      [base + 10, y],
      [base + 20, z],
    ];
  }

  private add(type: string, style: DxfStyle, body: ReadonlyArray<Group>, xdata?: DxfXdata): void {
    const handle = (this.handleCounter++).toString(16).toUpperCase();
    const colour: Group[] =
      style.color === null
        ? []
        : [
            [62, hexToAci(style.color)],
            [420, hexColor(style.color)],
          ];
    const extended: Group[] =
      xdata === undefined
        ? []
        : [
            [1001, LLULL_APP],
            [1000, xdata.tag],
            ...(xdata.ints ?? []).map((value): Group => [1070, value]),
            ...(xdata.points ?? []).flatMap(([x, y, z]): Group[] => [
              [1010, x],
              [1020, y],
              [1030, z],
            ]),
          ];
    this.lines.push(
      ...flatten([[0, type], [5, handle], [330, '1F'], [100, 'AcDbEntity'], [8, style.layer], ...colour, ...body, ...extended]),
    );
    this.entityCount += 1;
  }

  line(style: DxfStyle, a: Vec2, b: Vec2, z: number): void {
    this.add('LINE', style, [[100, 'AcDbLine'], ...this.xy(10, a, z), ...this.xy(11, b, z)]);
  }

  circle(style: DxfStyle, center: Vec2, radius: number, z: number): void {
    this.add('CIRCLE', style, [[100, 'AcDbCircle'], ...this.xy(10, center, z), [40, radius]]);
    this.extend(center[0] - radius, center[1] - radius);
    this.extend(center[0] + radius, center[1] + radius);
  }

  /** Counter-clockwise arc from `start` to `end` (radians). */
  arc(style: DxfStyle, center: Vec2, radius: number, start: number, end: number, z: number): void {
    this.add('ARC', style, [
      [100, 'AcDbCircle'],
      ...this.xy(10, center, z),
      [40, radius],
      [100, 'AcDbArc'],
      [50, toDegrees(start)],
      [51, toDegrees(end)],
    ]);
    this.extend(center[0] - radius, center[1] - radius);
    this.extend(center[0] + radius, center[1] + radius);
  }

  /** Complete ellipse; `major` is the semi-major vector from the centre, `ratio` minor / major (<= 1). */
  ellipse(style: DxfStyle, center: Vec2, major: Vec2, ratio: number, z: number): void {
    this.add('ELLIPSE', style, [
      [100, 'AcDbEllipse'],
      ...this.xy(10, center, z),
      [11, major[0]],
      [21, major[1]],
      [31, 0],
      [210, 0],
      [220, 0],
      [230, 1],
      [40, ratio],
      [41, 0],
      [42, 2 * Math.PI],
    ]);
    const reach = Math.hypot(major[0], major[1]);
    this.extend(center[0] - reach, center[1] - reach);
    this.extend(center[0] + reach, center[1] + reach);
  }

  polyline(style: DxfStyle, points: ReadonlyArray<Vec2>, closed: boolean, z: number, xdata?: DxfXdata): void {
    this.add(
      'LWPOLYLINE',
      style,
      [
        [100, 'AcDbPolyline'],
        [90, points.length],
        [70, closed ? 1 : 0],
        ...(z === 0 ? [] : ([[38, z]] as Group[])),
        ...points.flatMap((point): Group[] => {
          this.extend(point[0], point[1]);
          return [
            [10, point[0]],
            [20, point[1]],
          ];
        }),
      ],
      xdata,
    );
  }

  /** Degree-3 B-spline; `knots.length` must be `controls.length + 4`. */
  spline(style: DxfStyle, knots: readonly number[], controls: ReadonlyArray<Vec2>, closed: boolean, z: number, xdata?: DxfXdata): void {
    this.add(
      'SPLINE',
      style,
      [
        [100, 'AcDbSpline'],
        [210, 0],
        [220, 0],
        [230, 1],
        [70, (closed ? 1 : 0) | 8],
        [71, 3],
        [72, knots.length],
        [73, controls.length],
        [74, 0],
        [42, 1e-7],
        [43, 1e-7],
        ...knots.map((knot): Group => [40, knot]),
        ...controls.flatMap((control): Group[] => this.xy(10, control, z)),
      ],
      xdata,
    );
  }

  point(style: DxfStyle, at: Vec2, z: number): void {
    this.add('POINT', style, [[100, 'AcDbPoint'], ...this.xy(10, at, z)]);
  }

  /** Single-line TEXT at `at` (the alignment point for `center` / `right`), rotation in radians. */
  text(style: DxfStyle, at: Vec2, height: number, content: string, anchor: 'left' | 'center' | 'right', rotation: number, z: number): void {
    const aligned = anchor === 'left' ? [] : [...this.xy(11, at, z)];
    this.add('TEXT', style, [
      [100, 'AcDbText'],
      ...this.xy(10, at, z),
      [40, height],
      [1, dxfText(encodeTextLiterals(content))],
      ...(rotation === 0 ? [] : ([[50, toDegrees(rotation)]] as Group[])),
      ...(anchor === 'left' ? [] : ([[72, anchor === 'center' ? 1 : 2]] as Group[])),
      ...aligned,
      [100, 'AcDbText'],
    ]);
    this.extendByTextBox(at, height, content.length, anchor, rotation);
  }

  /** Multi-line MTEXT whose first baseline is at `at` (insertion at the top of the first line), rotation in radians. */
  mtext(
    style: DxfStyle,
    at: Vec2,
    height: number,
    content: string,
    anchor: 'left' | 'center' | 'right',
    rotation: number,
    z: number,
  ): void {
    const [c, s] = [Math.cos(rotation), Math.sin(rotation)];
    const top: Vec2 = [at[0] - s * height, at[1] + c * height];
    const escape = (line: string): string =>
      dxfText([...line].map((ch) => (ch === '\\' || ch === '{' || ch === '}' ? `\\${ch}` : ch)).join(''));
    const text = content.split(/\r?\n/).map(escape).join('\\P');
    this.add('MTEXT', style, [
      [100, 'AcDbMText'],
      ...this.xy(10, top, z),
      [40, height],
      [41, 0],
      [71, anchor === 'left' ? 1 : anchor === 'center' ? 2 : 3],
      [72, 1],
      [1, text],
      [11, c],
      [21, s],
      [31, 0],
    ]);
    const widest = Math.max(...content.split(/\r?\n/).map((line) => line.length));
    this.extendByTextBox(at, height, widest, anchor, rotation);
  }

  private extendByTextBox(at: Vec2, height: number, characters: number, anchor: 'left' | 'center' | 'right', rotation: number): void {
    const width = characters * height * TEXT_WIDTH_PER_HEIGHT;
    const left = anchor === 'left' ? 0 : anchor === 'center' ? -width / 2 : -width;
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

  /** Even-odd HATCH of closed `loops` (outline polygons, no bulges) at elevation `z`. */
  hatch(
    style: DxfStyle,
    loops: ReadonlyArray<ReadonlyArray<Vec2>>,
    fill: DxfHatchFill,
    z: number,
    outermost: ReadonlyArray<boolean>,
  ): void {
    const pattern: Group[] =
      fill.kind === 'solid'
        ? [[76, 1]]
        : [
            [76, 0],
            [52, toDegrees(fill.angle)],
            [41, fill.spacing],
            [77, fill.cross ? 1 : 0],
            [78, fill.cross ? 2 : 1],
            ...[0, ...(fill.cross ? [Math.PI / 2] : [])].flatMap((turn): Group[] => {
              const theta = fill.angle + turn;
              return [
                [53, toDegrees(theta)],
                [43, 0],
                [44, 0],
                [45, -fill.spacing * Math.sin(theta)],
                [46, fill.spacing * Math.cos(theta)],
                [79, 0],
              ];
            }),
          ];
    this.add('HATCH', style, [
      [100, 'AcDbHatch'],
      [10, 0],
      [20, 0],
      [30, z],
      [210, 0],
      [220, 0],
      [230, 1],
      [2, fill.kind === 'solid' ? 'SOLID' : '_USER'],
      [70, fill.kind === 'solid' ? 1 : 0],
      [71, 0],
      [91, loops.length],
      ...loops.flatMap((loop, index): Group[] => [
        [92, outermost[index] === true ? 3 : 2],
        [72, 0],
        [73, 1],
        [93, loop.length],
        ...loop.flatMap((point): Group[] => {
          this.extend(point[0], point[1]);
          return [
            [10, point[0]],
            [20, point[1]],
          ];
        }),
        [97, 0],
      ]),
      [75, 0],
      ...pattern,
      [98, 0],
    ]);
  }

  /** The complete file text: header ($INSUNITS, extents), symbol tables, model / paper space blocks, entities, objects. */
  assemble(unit: keyof typeof INSUNITS): string {
    return assembleFile({
      unit,
      bounds: this.bounds(),
      handleSeed: this.handleCounter + 1,
      layers: this.layerDefs,
      entityLines: this.lines,
    });
  }
}
