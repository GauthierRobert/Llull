/** Elevations and sections as printable SVG drawing sheets over the hidden-line projection. */

import type { CadDocument, Vec2 } from '@core/model/types';
import { DrawingPainter, svgLine } from '../../shared/drawingSvg';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, confirmExportControlled } from '@core/commands/schema';
import { toMetres, toMm } from '@core/model/units';
import { elementsOf, fileSlug, getBuilding } from '../model';
import { noop, report, exportRefusal } from '@core/commands/noop';
import { escapeXml } from '@lib/escapeXml';
import { sub2 } from '@lib/vec2';
import { ELEVATION_DIRECTIONS, buildElevationDrawing, type ElevationDirection } from './elevationProjection';
import {
  PAPER_MM,
  PAPER_FIELD,
  SCALE_FIELD,
  sheetFitWarning,
  type PaperSize,
  type Viewport,
  composeSheetSvg,
  fitScale,
  n,
  sheetDrawingArea,
} from '../../shared/sheetFrame';

export interface ElevationSheet {
  readonly filename: string;
  readonly svg: string;
  readonly paper: PaperSize;
  readonly scale: number;
  /** Drawing primitives in the view (edges, centre lines, cut faces). */
  readonly lines: number;
  /** False when the view extents exceed the view area of the paper at this scale. */
  readonly fits: boolean;
}

/** Space kept around the view for grid bubbles (top) and level marks (right), paper mm. */
const ANNOTATION_TOP = 14;
const ANNOTATION_RIGHT = 34;

/** @failure no 3D geometry / invalid scale -> null */
function buildElevationSheet(
  doc: CadDocument,
  options: {
    direction: ElevationDirection;
    cutAt: number | undefined;
    exclude: ReadonlyArray<string> | undefined;
    paper: PaperSize;
    scale: number | undefined;
    title: string | undefined;
  },
): ElevationSheet | null {
  const drawing = buildElevationDrawing(doc, options);
  const { paper } = options;
  if (!drawing || (options.scale !== undefined && options.scale <= 0)) return null;
  const [width, height] = PAPER_MM[paper];
  const outer = sheetDrawingArea(width, height);
  const viewport: Viewport = {
    x: outer.x,
    y: outer.y + ANNOTATION_TOP,
    width: outer.width - ANNOTATION_RIGHT,
    height: outer.height - ANNOTATION_TOP - 8,
  };
  const millimetresPerUnit = toMm(doc, 1);
  const [minU, minZ, maxU, maxZ] = drawing.bounds;
  const scale = options.scale ?? fitScale((maxU - minU) * millimetresPerUnit, (maxZ - minZ) * millimetresPerUnit, viewport);
  const k = millimetresPerUnit / scale;
  const offsetX = viewport.x + (viewport.width - (maxU - minU) * k) / 2;
  const offsetY = viewport.y + viewport.height - (viewport.height - (maxZ - minZ) * k) / 2;
  const toPaper = ([u, z]: Vec2): Vec2 => [offsetX + (u - minU) * k, offsetY - (z - minZ) * k];
  const painter = new DrawingPainter(toPaper, k);
  for (const primitive of drawing.primitives) painter.paint(primitive);
  const view = painter.parts;

  const building = getBuilding(doc);
  const annotations: string[] = [];
  const [left, right] = [toPaper([minU, 0])[0] - 6, toPaper([maxU, 0])[0] + 6];
  const ground = building.levelOrder.map((id) => building.levels[id]?.elevation).filter((value): value is number => value !== undefined);
  // A ground line only where there is a building to stand on (a machine part has none).
  if (ground.length > 0) {
    const groundY = toPaper([0, Math.min(...ground)])[1];
    const belowGrade = toPaper([0, minZ])[1] - groundY;
    if (options.cutAt === undefined && belowGrade > 0) {
      view.push(
        `<rect x="${n(left - 4)}" y="${n(groundY)}" width="${n(right - left + 8)}" height="${n(belowGrade + 0.5)}" fill="#fff" fill-opacity="0.7"/>`,
      );
    }
    annotations.push(svgLine([left - 4, groundY], [right + 4, groundY], 'ground'));
  }
  for (const levelId of building.levelOrder) {
    const level = building.levels[levelId];
    if (!level) continue;
    const y = toPaper([0, level.elevation])[1];
    const metres = toMetres(doc, level.elevation);
    const datum = `${metres >= 0 ? '+' : ''}${metres.toFixed(3)}`;
    // A level named after its elevation ("+6.00") is labelled once, by the datum.
    const namedByElevation = Math.abs(Number(level.name) - metres) < 1e-6;
    const label = namedByElevation ? datum : `${escapeXml(level.name)} ${datum}`;
    annotations.push(
      svgLine([left, y], [right, y], 'hidden'),
      `<polygon points="${n(right + 2)},${n(y)} ${n(right)},${n(y - 2.5)} ${n(right + 4)},${n(y - 2.5)}" class="solid"/>`,
      `<text x="${n(right + 6)}" y="${n(y - 0.6)}" font-size="2.5" text-anchor="start">${label}</text>`,
    );
  }
  const screenAxis = 1 - drawing.projection.axis;
  const top = toPaper([0, maxZ])[1] - 4;
  const bottom = toPaper([0, minZ])[1] + 2;
  for (const grid of elementsOf(building, 'grid')) {
    const direction = sub2(grid.end, grid.start);
    const length = Math.hypot(direction[0], direction[1]);
    if (length === 0 || Math.abs((direction[screenAxis] as number) / length) > 0.01) continue;
    const x = toPaper([drawing.projection.u([grid.start[0], grid.start[1], 0]), 0])[0];
    annotations.push(
      svgLine([x, top], [x, bottom], 'center'),
      `<circle cx="${n(x)}" cy="${n(top - 4)}" r="4" class="frame-thin" fill="#fff"/>`,
      `<text x="${n(x)}" y="${n(top - 2.9)}" font-size="3" text-anchor="middle">${escapeXml(grid.mark)}</text>`,
    );
  }

  const title =
    options.title?.trim() ||
    (options.cutAt !== undefined
      ? `Section at ${drawing.projection.axis === 0 ? 'x' : 'y'} = ${options.cutAt}, viewed from ${options.direction}`
      : `${options.direction[0]?.toUpperCase() ?? ''}${options.direction.slice(1)} elevation`);
  const svg = composeSheetSvg(doc, {
    width,
    height,
    title,
    scale,
    paper,
    caption: `${title} · 1:${scale}${ground.length > 0 ? ' · levels in m' : ''}`,
    bodyId: 'view',
    body: view.join(''),
    style: '.ground{stroke:#000;stroke-width:0.7}',
    overlays: [`<g id="annotations">${annotations.join('')}</g>`],
  });
  const project = fileSlug(building.project.name, 'project');
  return {
    filename: `${project}_${fileSlug(title, 'elevation')}_${paper}_1-${scale}.svg`,
    svg: `${svg}\n`,
    paper,
    scale,
    lines: drawing.primitives.length,
    fits: (maxU - minU) * k <= viewport.width + 1e-9 && (maxZ - minZ) * k <= viewport.height + 1e-9,
  };
}

/**
 * @affects none; data = { filename, svg, paper, scale, lines }
 * @failure bad direction / paper / scale / cutAt, nothing to draw -> no data
 */
export const exportElevationSheet = defineCommand({
  name: 'export_elevation_sheet',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Produce a printable elevation or section drawing (SVG in real millimetres, print to PDF at 100%) drawn as an ISO 128 line drawing ' +
    'from the 3D model with hidden lines removed (visible edges heavy, centre lines chain-dotted): north / south / east / west elevation ' +
    '(+Y is north), or a section when cutAt is given (the model nearer to the viewer than the cut plane is removed; cut faces outlined ' +
    'heavy, hatched at 45°, steel filled solid). Shows level datums, grid bubbles, scale bar and the title block. Use exclude: ["panel"] ' +
    'to show the steel frame behind the cladding. data.svg holds the file text.',
  params: z.object({
    confirmExportControlled,
    direction: z
      .enum(ELEVATION_DIRECTIONS)
      .optional()
      .describe('Side the viewer stands on (north elevation = north façade seen from the north). Default south.'),
    cutAt: z.number().optional().describe('Section plane position on the viewing axis (y for north / south, x for east / west).'),
    exclude: z.array(z.string()).optional().describe('Building categories to leave out, e.g. ["panel", "slab"].'),
    paper: PAPER_FIELD,
    scale: SCALE_FIELD,
    title: z.string().optional().describe('Drawing title. Default "<Direction> elevation".'),
  }),
  run: (doc, { confirmExportControlled, direction = 'south', cutAt, exclude, paper = 'A3', scale, title }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_elevation_sheet', 'sheet', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const sheet = buildElevationSheet(doc, { direction, cutAt, exclude, paper, scale, title });
    if (!sheet) return noop(doc, 'export_elevation_sheet failed: no 3D geometry to draw (on that side of the cut) or invalid scale.');
    return report(
      doc,
      `Elevation sheet ${sheet.filename}: ${sheet.lines} drawn line(s) / cut face(s) at 1:${sheet.scale} on ${sheet.paper}.${sheetFitWarning(sheet.fits, 'view')}`,
      sheet,
    );
  },
});
