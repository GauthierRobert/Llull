import { ellipsePoint } from '@lib/arc';
import { type CadDocument, type DimensionEntity, type Entity, type Vec2, is2D, is3D } from '@core/model/types';
import { LINE_PATTERNS } from '@core/model/drawing';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, confirmExportControlled } from '@core/commands/schema';
import { fromMm } from '@core/model/units';
import { fileSlug, getBuilding } from '../model';
import { noop, report, exportRefusal } from '@core/commands/noop';
import { buildPlanDrawing } from '../drawings/planDrawing';
import { DEFAULT_DIMENSION_OFFSET, dimensionDrawing, dimensionText } from '@core/geometry/dimensionAnnotation';
import { entityPlanPoint } from '@core/geometry/entityFrame';
import { technicalView } from '@core/geometry/technicalView';
import { TOP_VIEW } from '@core/geometry/viewProjection';
import { assembleDxf, type DxfLineType } from '@lib/dxfWriter';
import { CENTER_LAYERS, DxfWriter, HIDDEN_LAYERS, writePrimitive } from './dxfWriter';

/** Strokes + label of a dimension (R12 DXF has no associative DIMENSION without anonymous blocks); false when its references are gone. */
function writeDimension(writer: DxfWriter, doc: CadDocument, entity: DimensionEntity, layer: string): boolean {
  const refs = entity.entityIds.map((refId) => doc.entities[refId]);
  const drawing = dimensionDrawing(entity.dimensionKind, refs, entity.offset ?? DEFAULT_DIMENSION_OFFSET);
  if (!drawing) return false;
  for (const [a, b] of drawing.segments) writer.line(layer, a, b);
  writer.text(layer, drawing.textAt, DIMENSION_TEXT_HEIGHT, dimensionText(entity, drawing.value, doc.displayPrecision), 'center');
  return true;
}

/** Dimension text height, drawing units (the viewport's default). */
const DIMENSION_TEXT_HEIGHT = 0.6;

/** @returns how many dimensions were exported (as lines + text) */
function writeDrafting(writer: DxfWriter, doc: CadDocument): number {
  let dimensions = 0;
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
          [world([0, 0]), world([entity.width, 0]), world([entity.width, entity.height]), world([0, entity.height])],
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
      case 'dimension':
        if (writeDimension(writer, doc, entity, layer)) dimensions += 1;
        break;
      case 'image':
        break; // a raster underlay is tracing reference, not drawing content
      default:
        break;
    }
  }
  return dimensions;
}

/** Non-building 3D solids as their technical top view — the drawing the 2D view shows. */
function writeSolids(writer: DxfWriter, doc: CadDocument, hatchSpacing: number): void {
  const solids = doc.order
    .map((id) => doc.entities[id])
    .filter((entity): entity is Entity => !!entity && is3D(entity) && !entity.tags?.includes('bim'));
  for (const { primitives } of technicalView(doc, solids, { frame: TOP_VIEW })) {
    for (const primitive of primitives) writePrimitive(writer, primitive, hatchSpacing);
  }
}

/** Pattern unit of the DXF line types, drawing units (scaled further by LTSCALE). */
const LTYPE_UNIT = 0.25;

/** An ISO pattern ([dash, gap, …] in pattern units) as a DXF line type. */
const lineType = (name: string, description: string, pattern: ReadonlyArray<number>): DxfLineType => ({
  name,
  description,
  lengths: pattern.map((length, index) => length * LTYPE_UNIT * (index % 2 === 0 ? 1 : -1)),
});

const LINE_TYPES: ReadonlyArray<DxfLineType> = [
  lineType('DASHED', '__ __ __', LINE_PATTERNS.hidden),
  lineType('CENTER', '____ _ ____ _', LINE_PATTERNS.center),
];

const layerLineType = (layer: string): string => (HIDDEN_LAYERS.has(layer) ? 'DASHED' : CENTER_LAYERS.has(layer) ? 'CENTER' : 'CONTINUOUS');

/** The complete R12 file text (header, line types, layer table, entities) of everything `writer` holds. */
export const assembleAecDxf = (doc: Pick<CadDocument, 'units'>, writer: DxfWriter): string =>
  assembleDxf(doc.units, writer, LINE_TYPES, layerLineType);

export type DxfExport = {
  readonly filename: string;
  readonly dxf: string;
  readonly entityCount: number;
  readonly layers: string[];
  readonly dimensions: number;
};

/**
 * Builds the DXF text. @pure
 * @failure unknown level -> null
 */
function buildDxf(doc: CadDocument, levelId: string | undefined, includeDrafting: boolean): DxfExport | null {
  const building = getBuilding(doc);
  const writer = new DxfWriter();
  let levelLabel = 'drafting';
  let dimensions = 0;
  const hatchSpacing = fromMm(doc, 150);
  if (building.levelOrder.length > 0 || levelId !== undefined) {
    const plan = buildPlanDrawing(doc, levelId);
    if (!plan) return null;
    for (const primitive of plan.primitives) writePrimitive(writer, primitive, hatchSpacing);
    levelLabel = plan.level.name;
  }
  if (includeDrafting) {
    dimensions = writeDrafting(writer, doc);
    writeSolids(writer, doc, hatchSpacing);
  }
  const dxf = assembleAecDxf(doc, writer);
  return {
    filename: `${fileSlug(building.project.name, 'project')}_${fileSlug(levelLabel, 'plan')}.dxf`,
    dxf: `${dxf}\n`,
    entityCount: writer.entityCount,
    layers: [...writer.layers.keys()],
    dimensions,
  };
}

/**
 * @affects none; data = { filename, dxf, entityCount, layers, dimensions }
 * @failure unknown level / nothing to export -> no data
 */
export const exportBuildingDxf = defineCommand({
  name: 'export_building_dxf',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export a BUILDING floor-plan DXF of one level (civil entities: use export_civil_dxf) (AutoCAD R12 ASCII, opens in AutoCAD, BricsCAD, DraftSight, LibreCAD, Revit…) of a level floor plan: wall poché cut at ' +
    '1.2 m, door swings, windows, columns, beams (dashed), stairs, room tags, grid bubbles and overall / grid dimensions on AIA layers ' +
    '(A-WALL, A-DOOR, A-GLAZ, S-GRID…), plus the document’s own 2D drafting and its 3D solids as a technical top view (visible edges on ' +
    'OBJ-VISIBLE, hidden edges dashed on OBJ-HIDDEN, centre lines on OBJ-CENTER). Drafting dimensions (linear, aligned, radial, diameter, ' +
    'angular) are exported as extension / dimension lines, arrowheads and the measured text on the dimension’s layer (not as associative ' +
    'DIMENSION entities). data.dxf holds the file text; data.dimensions counts them.',
  params: z.object({
    confirmExportControlled,
    levelId: z.string().optional().describe('Level to plot. Default: the active level.'),
    includeDrafting: z
      .boolean()
      .optional()
      .describe(
        'Also export non-building 2D entities (lines, polylines, circles, text…) and the top view of non-building 3D solids. Default true.',
      ),
  }),
  run: (doc, { confirmExportControlled, levelId, includeDrafting = true }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_building_dxf', 'data', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const result = buildDxf(doc, levelId, includeDrafting);
    if (!result) return noop(doc, `export_building_dxf failed: no level '${levelId ?? ''}'.`);
    if (result.entityCount === 0)
      return noop(doc, 'export_building_dxf: nothing to export (no building elements, 2D drafting or 3D solids).');
    const dimensionNote =
      result.dimensions > 0
        ? ` ${result.dimensions} dimension(s) written as lines + text on their own layer (R12 has no associative DIMENSION).`
        : '';
    return report(
      doc,
      `DXF ${result.filename}: ${result.entityCount} entities on layers ${result.layers.join(', ')}.${dimensionNote}`,
      result,
    );
  },
});
