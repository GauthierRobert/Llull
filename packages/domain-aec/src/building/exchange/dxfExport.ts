/**
 * @layer domain-aec
 */

import { ellipsePoint } from '@lib/arc';
import { type CadDocument, type Entity, type Vec2, is2D, is3D } from '@core/model/types';
import { LINE_PATTERNS } from '@core/model/drawing';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fromMm } from '@core/model/units';
import { fileSlug, getBuilding } from '../model';
import { noop, report } from '@core/commands/noop';
import { buildPlanDrawing } from '../drawings/planDrawing';
import { entityPlanPoint } from '@core/geometry/entityFrame';
import { technicalView } from '@core/geometry/technicalView';
import { TOP_VIEW } from '@core/geometry/viewProjection';
import {
  CENTER_LAYERS,
  DxfWriter,
  HIDDEN_LAYERS,
  INSUNITS,
  fmt,
  writePrimitive,
} from './dxfWriter';

function writeDrafting(writer: DxfWriter, doc: CadDocument): void {
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (!entity || !is2D(entity) || entity.tags?.includes('bim')) continue;
    const layer = doc.layers[entity.layerId]?.name ?? '0';
    const world = (point: Vec2): Vec2 => entityPlanPoint(entity, point);
    switch (entity.kind) {
      case 'line':
        writer.line(layer, world(entity.start), world(entity.end));
        break;
      case 'polyline':
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
        const samples = Array.from({ length: 64 }, (_, index): Vec2 => {
          const t = (index / 64) * Math.PI * 2;
          return world(ellipsePoint(entity.center, entity.radiusX, entity.radiusY, t));
        });
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
      case 'image':
        break; // a raster underlay is tracing reference, not drawing content
      default:
        break;
    }
  }
}

/** Non-building 3D solids as their technical top view — the drawing the 2D view shows. */
function writeSolids(writer: DxfWriter, doc: CadDocument, hatchSpacing: number): void {
  const solids = doc.order
    .map((id) => doc.entities[id])
    .filter(
      (entity): entity is Entity => !!entity && is3D(entity) && !entity.tags?.includes('bim'),
    );
  for (const { primitives } of technicalView(doc, solids, { frame: TOP_VIEW })) {
    for (const primitive of primitives) writePrimitive(writer, primitive, hatchSpacing);
  }
}

type Group = readonly [code: number, value: string | number];

const flatten = (groups: ReadonlyArray<Group>): string[] =>
  groups.flatMap(([code, value]) => [String(code), String(value)]);

function header(
  doc: Pick<CadDocument, 'units'>,
  bounds: readonly [number, number, number, number],
): string[] {
  return flatten([
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$ACADVER'],
    [1, 'AC1009'],
    [9, '$INSUNITS'],
    [70, INSUNITS[doc.units]],
    [9, '$EXTMIN'],
    [10, fmt(bounds[0])],
    [20, fmt(bounds[1])],
    [30, 0],
    [9, '$EXTMAX'],
    [10, fmt(bounds[2])],
    [20, fmt(bounds[3])],
    [30, 0],
    [0, 'ENDSEC'],
  ]);
}

/** Pattern unit of the DXF line types, drawing units (scaled further by LTSCALE). */
const LTYPE_UNIT = 0.25;

/** An LTYPE table entry for an ISO pattern (dashes positive, gaps negative). */
function lineType(name: string, description: string, pattern: ReadonlyArray<number>): Group[] {
  const lengths = pattern.map((length, index) => length * LTYPE_UNIT * (index % 2 === 0 ? 1 : -1));
  return [
    [0, 'LTYPE'],
    [2, name],
    [70, 0],
    [3, description],
    [72, 65],
    [73, pattern.length],
    [40, fmt(lengths.reduce((sum, length) => sum + Math.abs(length), 0))],
    ...lengths.map((length): Group => [49, fmt(length)]),
  ];
}

function tables(layers: ReadonlyMap<string, number>): string[] {
  const groups: Group[] = [
    [0, 'SECTION'],
    [2, 'TABLES'],
    [0, 'TABLE'],
    [2, 'LTYPE'],
    [70, 3],
    [0, 'LTYPE'],
    [2, 'CONTINUOUS'],
    [70, 0],
    [3, 'Solid line'],
    [72, 65],
    [73, 0],
    [40, '0.0'],
    ...lineType('DASHED', '__ __ __', LINE_PATTERNS.hidden),
    ...lineType('CENTER', '____ _ ____ _', LINE_PATTERNS.center),
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'LAYER'],
    [70, layers.size + 1],
    [0, 'LAYER'],
    [2, '0'],
    [70, 0],
    [62, 7],
    [6, 'CONTINUOUS'],
  ];
  for (const [name, color] of layers) {
    if (name === '0') continue;
    groups.push(
      [0, 'LAYER'],
      [2, name],
      [70, 0],
      [62, color],
      [6, HIDDEN_LAYERS.has(name) ? 'DASHED' : CENTER_LAYERS.has(name) ? 'CENTER' : 'CONTINUOUS'],
    );
  }
  groups.push([0, 'ENDTAB'], [0, 'ENDSEC']);
  return flatten(groups);
}

/** The complete R12 file text (header, layer table, entities) of everything `writer` holds. */
export function assembleDxf(doc: Pick<CadDocument, 'units'>, writer: DxfWriter): string {
  return [
    ...header(doc, writer.bounds()),
    ...tables(writer.layers),
    ...flatten([
      [0, 'SECTION'],
      [2, 'ENTITIES'],
    ]),
    ...writer.lines,
    ...flatten([
      [0, 'ENDSEC'],
      [0, 'EOF'],
    ]),
  ].join('\n');
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
function buildDxf(
  doc: CadDocument,
  levelId: string | undefined,
  includeDrafting: boolean,
): DxfExport | null {
  const building = getBuilding(doc);
  const writer = new DxfWriter();
  let levelLabel = 'drafting';
  const hatchSpacing = fromMm(doc, 150);
  if (building.levelOrder.length > 0 || levelId !== undefined) {
    const plan = buildPlanDrawing(doc, levelId);
    if (!plan) return null;
    for (const primitive of plan.primitives) writePrimitive(writer, primitive, hatchSpacing);
    levelLabel = plan.level.name;
  }
  if (includeDrafting) {
    writeDrafting(writer, doc);
    writeSolids(writer, doc, hatchSpacing);
  }
  const dxf = assembleDxf(doc, writer);
  return {
    filename: `${fileSlug(building.project.name, 'project')}_${fileSlug(levelLabel, 'plan')}.dxf`,
    dxf: `${dxf}\n`,
    entityCount: writer.entityCount,
    layers: [...writer.layers.keys()],
  };
}

/**
 * @command export_dxf
 * @pure read-only
 * @affects none; data = { filename, dxf, entityCount, layers }
 * @failure unknown level / nothing to export -> no data
 */
export const exportDxf = defineCommand({
  name: 'export_dxf',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export a DXF (AutoCAD R12 ASCII, opens in AutoCAD, BricsCAD, DraftSight, LibreCAD, Revit…) of a ' +
    'level floor plan: wall poché cut at 1.2 m, door swings, windows, columns, beams (dashed), stairs, ' +
    'room tags, grid bubbles and overall / grid dimensions on AIA layers (A-WALL, A-DOOR, A-GLAZ, S-GRID…), ' +
    'plus the document’s own 2D drafting and its 3D solids as a technical top view (visible edges on ' +
    'OBJ-VISIBLE, hidden edges dashed on OBJ-HIDDEN, centre lines on OBJ-CENTER). data.dxf holds the file text.',
  params: z.object({
    levelId: z.string().optional().describe('Level to plot. Default: the active level.'),
    includeDrafting: z
      .boolean()
      .optional()
      .describe(
        'Also export non-building 2D entities (lines, polylines, circles, text…) and the top view of non-building 3D solids. Default true.',
      ),
  }),
  run: (doc, { levelId, includeDrafting = true }): CommandResult => {
    const result = buildDxf(doc, levelId, includeDrafting);
    if (!result) return noop(doc, `export_dxf failed: no level '${levelId ?? ''}'.`);
    if (result.entityCount === 0)
      return noop(
        doc,
        'export_dxf: nothing to export (no building elements, 2D drafting or 3D solids).',
      );
    return report(
      doc,
      `DXF ${result.filename}: ${result.entityCount} entities on layers ${result.layers.join(', ')}.`,
      result,
    );
  },
});
