/**
 * Printable floor-plan sheet: SVG at a true architectural scale on ISO A paper, with title block,
 * north arrow, scale bar and dimensions. Print / save as PDF from any browser.
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { toMm } from '@core/model/units';
import { fileSlug, getBuilding } from '../model';
import { noop, report } from '@core/commands/noop';
import { buildPlanDrawing } from './planDrawing';
import { DrawingPainter } from '../../shared/drawingSvg';
import {
  composeSheetSvg,
  fitScale,
  MARGIN,
  paperMap,
  northArrow,
  PAPER_MM,
  PAPER_FIELD,
  SCALE_FIELD,
  sheetFitWarning,
  sheetDrawingArea,
  type PaperSize,
} from '../../shared/sheetFrame';

export interface PlanSheet {
  readonly filename: string;
  readonly svg: string;
  readonly paper: PaperSize;
  readonly scale: number;
  readonly levelId: string;
  /** False when the drawing extents exceed the drawing area of the paper at this scale. */
  readonly fits: boolean;
}

/** @failure unknown level, invalid paper or scale -> null */
function buildPlanSheet(
  doc: CadDocument,
  levelId: string | undefined,
  paper: PaperSize,
  requestedScale: number | undefined,
  requestedTitle: string | undefined,
): PlanSheet | null {
  const drawing = buildPlanDrawing(doc, levelId);
  if (!drawing || (requestedScale !== undefined && requestedScale <= 0)) return null;
  const [width, height] = PAPER_MM[paper];
  const viewport = sheetDrawingArea(width, height);
  const millimetresPerUnit = toMm(doc, 1);
  const [minX, minY, maxX, maxY] = drawing.bounds;
  const scale = requestedScale ?? fitScale((maxX - minX) * millimetresPerUnit, (maxY - minY) * millimetresPerUnit, viewport);
  const paperPerUnit = millimetresPerUnit / scale;
  const painter = new DrawingPainter(paperMap(viewport, [(minX + maxX) / 2, (minY + maxY) / 2], paperPerUnit), paperPerUnit);
  for (const primitive of drawing.primitives) painter.paint(primitive);
  const title = requestedTitle?.trim() || `${drawing.level.name} — Floor plan`;
  const svg = composeSheetSvg(doc, {
    width,
    height,
    title,
    scale,
    paper,
    caption: `${title} · 1:${scale} · dimensions in mm`,
    bodyId: 'plan',
    body: painter.parts.join(''),
    overlays: [northArrow(width - MARGIN - 12, MARGIN + 12)],
  });
  const project = fileSlug(getBuilding(doc).project.name, 'project');
  return {
    filename: `${project}_${fileSlug(drawing.level.name, 'level')}_${paper}_1-${scale}.svg`,
    svg: `${svg}\n`,
    paper,
    scale,
    levelId: drawing.level.id,
    fits: ((maxX - minX) * millimetresPerUnit) / scale <= viewport.width && ((maxY - minY) * millimetresPerUnit) / scale <= viewport.height,
  };
}

/**
 * @affects none; data = { filename, svg, paper, scale, levelId }
 * @failure unknown level / paper / invalid scale -> no data
 */
export const exportPlanSheet = defineCommand({
  name: 'export_plan_sheet',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Produce a printable floor-plan drawing sheet (SVG in real millimetres, print to PDF at 100%): the ' +
    'level plan at a true scale (1:50, 1:100…; auto-fitted when omitted) on ISO paper A4–A0 landscape, with ' +
    'wall poché, doors, windows, grids, room tags, dimensions in mm, north arrow, scale bar and a title block ' +
    'filled from set_project_info. data.svg holds the file text.',
  params: z.object({
    levelId: z.string().optional().describe('Level to draw. Default: active level.'),
    paper: PAPER_FIELD,
    scale: SCALE_FIELD,
    title: z.string().optional().describe('Drawing title. Default "<level> — Floor plan".'),
  }),
  run: (doc, { levelId, paper = 'A3', scale, title }): CommandResult => {
    const sheet = buildPlanSheet(doc, levelId, paper, scale, title);
    if (!sheet) {
      return noop(doc, 'export_plan_sheet failed: no such level (add_level / draw_walls first) or invalid scale (must be > 0).');
    }
    return report(
      doc,
      `Plan sheet ${sheet.filename}: level ${sheet.levelId} at 1:${sheet.scale} on ${sheet.paper}.${sheetFitWarning(sheet.fits, 'drawing')}`,
      sheet,
    );
  },
});
