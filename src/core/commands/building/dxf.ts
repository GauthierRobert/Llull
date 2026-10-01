/**
 * DXF (AutoCAD R12 / AC1009 ASCII) export of a level plan plus the document's 2D drafting.
 * @layer core/commands/building
 */

import type { CadDocument, DocumentUnit, Entity, Vec2 } from '../../model/types';
import { is2D } from '../../model/types';
import type { CommandDefinition, CommandResult } from '../types';
import { fileSlug, getBuilding, noChange } from './model';
import { buildPlanDrawing, DIMENSION_LAYER, type PlanPrimitive } from './plan';

/** AutoCAD $INSUNITS codes. */
const INSUNITS: Readonly<Record<DocumentUnit, number>> = { in: 1, ft: 2, mm: 4, cm: 5, m: 6 };

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

const HIDDEN_LAYERS: ReadonlySet<string> = new Set(['S-BEAM']);

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

const fmt = (value: number): string => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

class DxfWriter {
  private readonly lines: string[] = [];
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
    if (!this.layers.has(name)) this.layers.set(name, LAYER_COLOR[name] ?? 7);
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

  point2(layer: string, at: Vec2): void {
    this.start('POINT', layer);
    this.point(10, at);
  }

  entitiesSection(): string[] {
    return this.lines;
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

function writePrimitive(writer: DxfWriter, primitive: PlanPrimitive): void {
  switch (primitive.type) {
    case 'polygon':
      writer.polyline(primitive.layer, primitive.points, true);
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
      return;
    case 'text':
      writer.text(primitive.layer, primitive.at, primitive.height, primitive.content, 'center');
      return;
    case 'dimension':
      writeDimension(writer, primitive);
      return;
  }
}

/** Places a local 2D point of `entity` in world plan coordinates (position + Z rotation). */
function toWorld(entity: Entity, [x, y]: Vec2): Vec2 {
  const angle = entity.rotation[2];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [entity.position[0] + x * cos - y * sin, entity.position[1] + x * sin + y * cos];
}

function writeDrafting(writer: DxfWriter, doc: CadDocument): void {
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (!entity || !is2D(entity) || entity.tags?.includes('bim')) continue;
    const layer = doc.layers[entity.layerId]?.name ?? '0';
    const world = (point: Vec2): Vec2 => toWorld(entity, point);
    switch (entity.kind) {
      case 'line':
        writer.line(layer, world(entity.start), world(entity.end));
        break;
      case 'polyline':
        writer.polyline(layer, entity.points.map(world), entity.closed);
        break;
      case 'spline':
        writer.polyline(layer, entity.points.map(world), entity.closed);
        break;
      case 'rectangle':
        writer.polyline(
          layer,
          [
            world([0, 0]),
            world([entity.width, 0]),
            world([entity.width, entity.height]),
            world([0, entity.height]),
          ],
          true,
        );
        break;
      case 'circle':
        writer.circle(layer, world(entity.center), entity.radius);
        break;
      case 'arc':
        writer.arc(
          layer,
          world(entity.center),
          entity.radius,
          entity.startAngle + entity.rotation[2],
          entity.endAngle + entity.rotation[2],
        );
        break;
      case 'ellipse': {
        const samples: Vec2[] = [];
        for (let index = 0; index < 64; index++) {
          const t = (index / 64) * Math.PI * 2;
          samples.push(
            world([
              entity.center[0] + entity.radiusX * Math.cos(t),
              entity.center[1] + entity.radiusY * Math.sin(t),
            ]),
          );
        }
        writer.polyline(layer, samples, true);
        break;
      }
      case 'text':
        writer.text(
          layer,
          [entity.position[0], entity.position[1]],
          entity.height,
          entity.content,
          entity.anchor ?? 'left',
          entity.rotation[2],
        );
        break;
      case 'point':
        writer.point2(layer, [entity.position[0], entity.position[1]]);
        break;
      default:
        break;
    }
  }
}

function header(doc: CadDocument, bounds: readonly [number, number, number, number]): string[] {
  return [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1009',
    '9',
    '$INSUNITS',
    '70',
    String(INSUNITS[doc.units]),
    '9',
    '$EXTMIN',
    '10',
    fmt(bounds[0]),
    '20',
    fmt(bounds[1]),
    '30',
    '0',
    '9',
    '$EXTMAX',
    '10',
    fmt(bounds[2]),
    '20',
    fmt(bounds[3]),
    '30',
    '0',
    '0',
    'ENDSEC',
  ];
}

function tables(layers: ReadonlyMap<string, number>): string[] {
  const out = [
    '0',
    'SECTION',
    '2',
    'TABLES',
    '0',
    'TABLE',
    '2',
    'LTYPE',
    '70',
    '2',
    '0',
    'LTYPE',
    '2',
    'CONTINUOUS',
    '70',
    '0',
    '3',
    'Solid line',
    '72',
    '65',
    '73',
    '0',
    '40',
    '0.0',
    '0',
    'LTYPE',
    '2',
    'DASHED',
    '70',
    '0',
    '3',
    '__ __ __',
    '72',
    '65',
    '73',
    '2',
    '40',
    '0.75',
    '49',
    '0.5',
    '49',
    '-0.25',
    '0',
    'ENDTAB',
    '0',
    'TABLE',
    '2',
    'LAYER',
    '70',
    String(layers.size + 1),
    '0',
    'LAYER',
    '2',
    '0',
    '70',
    '0',
    '62',
    '7',
    '6',
    'CONTINUOUS',
  ];
  for (const [name, color] of layers) {
    if (name === '0') continue;
    out.push(
      '0',
      'LAYER',
      '2',
      name,
      '70',
      '0',
      '62',
      String(color),
      '6',
      HIDDEN_LAYERS.has(name) ? 'DASHED' : 'CONTINUOUS',
    );
  }
  out.push('0', 'ENDTAB', '0', 'ENDSEC');
  return out;
}

export interface DxfExport {
  readonly filename: string;
  readonly dxf: string;
  readonly entityCount: number;
  readonly layers: string[];
}

/**
 * Builds the DXF text. @pure
 * @failure unknown level -> null
 */
export function buildDxf(
  doc: CadDocument,
  options: { levelId?: string; includeDrafting?: boolean },
): DxfExport | null {
  const building = getBuilding(doc);
  const writer = new DxfWriter();
  let levelLabel = 'drafting';
  if (building.levelOrder.length > 0 || options.levelId !== undefined) {
    const plan = buildPlanDrawing(doc, options.levelId);
    if (!plan) return null;
    for (const primitive of plan.primitives) writePrimitive(writer, primitive);
    levelLabel = plan.level.name;
  }
  if (options.includeDrafting !== false) writeDrafting(writer, doc);
  const body = writer.entitiesSection();
  const dxf = [
    ...header(doc, writer.bounds()),
    ...tables(writer.layers),
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    ...body,
    '0',
    'ENDSEC',
    '0',
    'EOF',
  ].join('\n');
  return {
    filename: `${fileSlug(building.project.name, 'project')}_${fileSlug(levelLabel, 'plan')}.dxf`,
    dxf: `${dxf}\n`,
    entityCount: writer.entityCount,
    layers: [...writer.layers.keys()],
  };
}

interface ExportDxfParams {
  levelId?: string;
  includeDrafting?: boolean;
}

/**
 * @command export_dxf
 * @pure read-only
 * @affects none; data = { filename, dxf, entityCount, layers }
 * @failure unknown level / nothing to export -> no data
 */
export const exportDxf: CommandDefinition<ExportDxfParams> = {
  name: 'export_dxf',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export a DXF (AutoCAD R12 ASCII, opens in AutoCAD, BricsCAD, DraftSight, LibreCAD, Revit…) of a ' +
    'level floor plan: wall poché cut at 1.2 m, door swings, windows, columns, beams (dashed), stairs, ' +
    'room tags, grid bubbles and overall / grid dimensions on AIA layers (A-WALL, A-DOOR, A-GLAZ, S-GRID…), ' +
    'plus the document’s own 2D drafting. data.dxf holds the file text.',
  paramsSchema: {
    type: 'object',
    properties: {
      levelId: { type: 'string', description: 'Level to plot. Default: the active level.' },
      includeDrafting: {
        type: 'boolean',
        description:
          'Also export non-building 2D entities (lines, polylines, circles, text…). Default true.',
      },
    },
    required: [],
  },
  run: (doc, { levelId, includeDrafting }): CommandResult => {
    const result = buildDxf(doc, {
      ...(levelId !== undefined ? { levelId } : {}),
      ...(includeDrafting !== undefined ? { includeDrafting } : {}),
    });
    if (!result) return noChange(doc, `export_dxf failed: no level '${levelId ?? ''}'.`);
    if (result.entityCount === 0) {
      return noChange(doc, 'export_dxf: nothing to export (no building elements or 2D drafting).');
    }
    return {
      document: doc,
      summary: `DXF ${result.filename}: ${result.entityCount} entities on layers ${result.layers.join(', ')}.`,
      affected: [],
      data: result,
    };
  },
};
