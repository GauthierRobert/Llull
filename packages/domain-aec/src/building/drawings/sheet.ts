/**
 * Printable floor-plan sheet: SVG at a true architectural scale on ISO A paper, with title block,
 * north arrow, scale bar and dimensions. Print / save as PDF from any browser.
 * @layer domain-aec
 */

import { clamp } from '@lib/clamp';
import type { CadDocument, Vec2 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { toMm } from '@core/model/units';
import { fileSlug, getBuilding } from '../model';
import { noop, report } from '@core/commands/noop';
import { type PlanDrawing, type PlanPrimitive } from './planModel';
import { buildPlanDrawing } from './planDrawing';
import { wrapAngle } from '@lib/angle';
import {
  composeSheetSvg,
  fitScale,
  MARGIN,
  n,
  paperMap,
  readableDimensionLabel,
  svgPoints,
  northArrow,
  PAPER_MM,
  PAPER_FIELD,
  SCALE_FIELD,
  sheetFitWarning,
  sheetDrawingArea,
  svgText,
  type PaperSize,
  type Viewport,
} from '../../shared/sheetFrame';

class SheetPainter {
  readonly parts: string[] = [];

  constructor(
    private readonly drawing: PlanDrawing,
    private readonly paperPerUnit: number,
    private readonly viewport: Viewport,
  ) {}

  map([x, y]: Vec2): Vec2 {
    const [minX, minY, maxX, maxY] = this.drawing.bounds;
    return paperMap(
      this.viewport,
      [(minX + maxX) / 2, (minY + maxY) / 2],
      this.paperPerUnit,
    )([x, y]);
  }

  private points(points: ReadonlyArray<Vec2>): string {
    return svgPoints(points.map((point) => this.map(point)));
  }

  private styleOf(style: PlanPrimitive['style'], filled: boolean): string {
    switch (style) {
      case 'cut':
        return filled ? 'class="cut"' : 'class="cut-line"';
      case 'hidden':
        return 'class="hidden"';
      case 'annotation':
      case 'thin':
        return 'class="thin"';
    }
  }

  text(at: Vec2, sizeMm: number, content: string, rotationDeg = 0): void {
    this.parts.push(svgText(at[0], at[1], sizeMm, 'middle', content, rotationDeg));
  }

  paint(primitive: PlanPrimitive): void {
    switch (primitive.type) {
      case 'polygon': {
        if (primitive.fill === 'hatch') {
          this.parts.push(`<polygon points="${this.points(primitive.points)}" class="cut-hatch"/>`);
          return;
        }
        const loops = [primitive.points, ...(primitive.holes ?? [])];
        const path = loops.map((loop) => `M${this.points(loop).replace(/ /g, 'L')}Z`).join('');
        this.parts.push(
          `<path d="${path}" fill-rule="evenodd" ${this.styleOf(primitive.style, true)}/>`,
        );
        return;
      }
      case 'polyline':
        this.parts.push(
          `<polyline points="${this.points(primitive.points)}" ${this.styleOf(primitive.style, false)}/>`,
        );
        return;
      case 'line': {
        const [a, b] = [this.map(primitive.a), this.map(primitive.b)];
        this.parts.push(
          `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" ${this.styleOf(primitive.style, false)}/>`,
        );
        return;
      }
      case 'circle': {
        const [cx, cy] = this.map(primitive.center);
        const fill = primitive.style === 'cut';
        this.parts.push(
          `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(primitive.radius * this.paperPerUnit)}" ${this.styleOf(primitive.style, fill)}/>`,
        );
        return;
      }
      case 'arc': {
        const { center, radius, startAngle, endAngle } = primitive;
        const start = this.map([
          center[0] + radius * Math.cos(startAngle),
          center[1] + radius * Math.sin(startAngle),
        ]);
        const end = this.map([
          center[0] + radius * Math.cos(endAngle),
          center[1] + radius * Math.sin(endAngle),
        ]);
        const sweep = wrapAngle(endAngle - startAngle);
        const r = n(radius * this.paperPerUnit);
        this.parts.push(
          `<path d="M ${n(start[0])} ${n(start[1])} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${n(end[0])} ${n(end[1])}" class="thin"/>`,
        );
        return;
      }
      case 'text': {
        const size = Math.max(primitive.height * this.paperPerUnit, 1.8);
        const [x, y] = this.map(primitive.at);
        this.text([x, y + size * 0.35], size, primitive.content);
        return;
      }
      case 'dimension':
        this.dimension(primitive);
        return;
    }
  }

  private dimension(primitive: Extract<PlanPrimitive, { type: 'dimension' }>): void {
    const a = this.map(primitive.a);
    const b = this.map(primitive.b);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) return;
    // Model "right of a→b" becomes "left of a→b" once Y is flipped on paper.
    const normal: Vec2 = [dy / length, -dx / length];
    const gap = clamp(primitive.offset * this.paperPerUnit, 6, 14);
    const along = (point: Vec2, distance: number): Vec2 => [
      point[0] - normal[0] * distance,
      point[1] - normal[1] * distance,
    ];
    const da = along(a, gap);
    const db = along(b, gap);
    const line = (p: Vec2, q: Vec2): string =>
      `<line x1="${n(p[0])}" y1="${n(p[1])}" x2="${n(q[0])}" y2="${n(q[1])}" class="dim"/>`;
    this.parts.push(
      line(along(a, 1.5), along(a, gap + 1.5)),
      line(along(b, 1.5), along(b, gap + 1.5)),
      line(da, db),
    );
    for (const end of [da, db])
      this.parts.push(line([end[0] - 1, end[1] + 1], [end[0] + 1, end[1] - 1]));
    const { angle, middle } = readableDimensionLabel(da, db, dx, dy);
    this.text(middle, 2.5, primitive.label, angle);
  }
}

export interface PlanSheet {
  readonly filename: string;
  readonly svg: string;
  readonly paper: PaperSize;
  readonly scale: number;
  readonly levelId: string;
  /** False when the drawing extents exceed the drawing area of the paper at this scale. */
  readonly fits: boolean;
}

/**
 * @pure
 * @failure unknown level, invalid paper or scale -> null
 */
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
  const scale =
    requestedScale ??
    fitScale((maxX - minX) * millimetresPerUnit, (maxY - minY) * millimetresPerUnit, viewport);
  const painter = new SheetPainter(drawing, millimetresPerUnit / scale, viewport);
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
    fits:
      ((maxX - minX) * millimetresPerUnit) / scale <= viewport.width &&
      ((maxY - minY) * millimetresPerUnit) / scale <= viewport.height,
  };
}

/**
 * @command export_plan_sheet
 * @pure read-only
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
      return noop(
        doc,
        'export_plan_sheet failed: no such level (add_level / draw_walls first) or invalid scale (must be > 0).',
      );
    }
    return report(
      doc,
      `Plan sheet ${sheet.filename}: level ${sheet.levelId} at 1:${sheet.scale} on ${sheet.paper}.${sheetFitWarning(sheet.fits, 'drawing')}`,
      sheet,
    );
  },
});
