/**
 * @layer domain-aec
 */

import { type CadDocument, type Entity, type Vec2, is2D } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fileSlug, fromMm, getBuilding } from './model';
import { noop } from '@core/commands/noop';
import { buildPlanDrawing } from './planDrawing';
import { DxfWriter, HIDDEN_LAYERS, INSUNITS, fmt, writePrimitive } from './dxfWriter';

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
          return world([
            entity.center[0] + entity.radiusX * Math.cos(t),
            entity.center[1] + entity.radiusY * Math.sin(t),
          ]);
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
      default:
        break;
    }
  }
}

type Group = readonly [code: number, value: string | number];

const flatten = (groups: ReadonlyArray<Group>): string[] =>
  groups.flatMap(([code, value]) => [String(code), String(value)]);

function header(doc: CadDocument, bounds: readonly [number, number, number, number]): string[] {
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

function tables(layers: ReadonlyMap<string, number>): string[] {
  const groups: Group[] = [
    [0, 'SECTION'],
    [2, 'TABLES'],
    [0, 'TABLE'],
    [2, 'LTYPE'],
    [70, 2],
    [0, 'LTYPE'],
    [2, 'CONTINUOUS'],
    [70, 0],
    [3, 'Solid line'],
    [72, 65],
    [73, 0],
    [40, '0.0'],
    [0, 'LTYPE'],
    [2, 'DASHED'],
    [70, 0],
    [3, '__ __ __'],
    [72, 65],
    [73, 2],
    [40, '0.75'],
    [49, '0.5'],
    [49, '-0.25'],
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
      [6, HIDDEN_LAYERS.has(name) ? 'DASHED' : 'CONTINUOUS'],
    );
  }
  groups.push([0, 'ENDTAB'], [0, 'ENDSEC']);
  return flatten(groups);
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
  if (building.levelOrder.length > 0 || levelId !== undefined) {
    const plan = buildPlanDrawing(doc, levelId);
    if (!plan) return null;
    const hatchSpacing = fromMm(doc, 150);
    for (const primitive of plan.primitives) writePrimitive(writer, primitive, hatchSpacing);
    levelLabel = plan.level.name;
  }
  if (includeDrafting) writeDrafting(writer, doc);
  const dxf = [
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
    'plus the document’s own 2D drafting. data.dxf holds the file text.',
  params: z.object({
    levelId: z.string().optional().describe('Level to plot. Default: the active level.'),
    includeDrafting: z
      .boolean()
      .optional()
      .describe(
        'Also export non-building 2D entities (lines, polylines, circles, text…). Default true.',
      ),
  }),
  run: (doc, { levelId, includeDrafting = true }): CommandResult => {
    const result = buildDxf(doc, levelId, includeDrafting);
    if (!result) return noop(doc, `export_dxf failed: no level '${levelId ?? ''}'.`);
    if (result.entityCount === 0) {
      return noop(doc, 'export_dxf: nothing to export (no building elements or 2D drafting).');
    }
    return {
      document: doc,
      summary: `DXF ${result.filename}: ${result.entityCount} entities on layers ${result.layers.join(', ')}.`,
      affected: [],
      data: result,
    };
  },
});
