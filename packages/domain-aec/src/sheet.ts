/**
 * Printable floor-plan sheet: SVG at a true architectural scale on ISO A paper, with title block,
 * north arrow, scale bar and dimensions. Print / save as PDF from any browser.
 * @layer domain-aec
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fileSlug, getBuilding, noChange, toMetres } from './model';
import { type PlanDrawing, type PlanPrimitive } from './planModel';
import { buildPlanDrawing } from './planDrawing';
import { escapeXml } from '@lib/escapeXml';

export type PaperSize = 'A4' | 'A3' | 'A2' | 'A1' | 'A0';

export const PAPER_SIZES = [
  'A4',
  'A3',
  'A2',
  'A1',
  'A0',
] as const satisfies ReadonlyArray<PaperSize>;

/** Landscape ISO 216 sizes, millimetres. */
export const PAPER_MM: Readonly<Record<PaperSize, readonly [number, number]>> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
};

const STANDARD_SCALES: ReadonlyArray<number> = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000,
];

export const MARGIN = 10;
export const BINDING_MARGIN = 20;
export const TITLE_HEIGHT = 42;

/** Drawing area of a `width`×`height` mm sheet: inside the frame margins, above the title block. @pure */
export function sheetDrawingArea(width: number, height: number): Viewport {
  return {
    x: BINDING_MARGIN + 4,
    y: MARGIN + 4,
    width: width - BINDING_MARGIN - MARGIN - 8,
    height: height - 2 * MARGIN - TITLE_HEIGHT - 8,
  };
}

const n = (value: number): string => String(Math.round(value * 100) / 100);

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Smallest standard scale 1:N at which the model extents fit the viewport. */
export function fitScale(widthMm: number, heightMm: number, viewport: Viewport): number {
  for (const scale of STANDARD_SCALES) {
    if (widthMm / scale <= viewport.width * 0.92 && heightMm / scale <= viewport.height * 0.92)
      return scale;
  }
  return STANDARD_SCALES[STANDARD_SCALES.length - 1] as number;
}

/** Shared drawing-sheet stylesheet (line weights in paper millimetres). */
export const SHEET_STYLE = [
  `<style>`,
  `.cut{fill:#4a4a4a;stroke:#000;stroke-width:0.35}.cut-line{fill:none;stroke:#000;stroke-width:0.35}`,
  `.thin{fill:none;stroke:#000;stroke-width:0.18}.hidden{fill:none;stroke:#000;stroke-width:0.18;stroke-dasharray:1.5 1}`,
  `.dim{stroke:#000;stroke-width:0.13}.frame{fill:none;stroke:#000;stroke-width:0.5}.frame-thin{fill:none;stroke:#000;stroke-width:0.25}`,
  `.solid{fill:#000;stroke:#000;stroke-width:0.25}.label{fill:#555}text{fill:#000}`,
  `.cut-hatch{fill:url(#hatch-concrete);stroke:#000;stroke-width:0.35}`,
  `</style>`,
].join('');

/** Shared fill patterns: ANSI31-style 45° hatch for concrete / masonry cuts. */
export const SHEET_DEFS =
  `<defs><pattern id="hatch-concrete" width="1.5" height="1.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
  `<rect width="1.5" height="1.5" fill="#d9d9d9"/><line x1="0" y1="0" x2="0" y2="1.5" stroke="#000" stroke-width="0.12"/></pattern></defs>`;

class SheetPainter {
  readonly parts: string[] = [];

  constructor(
    private readonly drawing: PlanDrawing,
    private readonly paperPerUnit: number,
    private readonly viewport: Viewport,
  ) {}

  map([x, y]: Vec2): Vec2 {
    const [minX, minY, maxX, maxY] = this.drawing.bounds;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return [
      this.viewport.x + this.viewport.width / 2 + (x - cx) * this.paperPerUnit,
      this.viewport.y + this.viewport.height / 2 - (y - cy) * this.paperPerUnit,
    ];
  }

  private points(points: ReadonlyArray<Vec2>): string {
    return points.map((point) => this.map(point).map(n).join(',')).join(' ');
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
    const [x, y] = at;
    const transform =
      rotationDeg !== 0 ? ` transform="rotate(${n(rotationDeg)} ${n(x)} ${n(y)})"` : '';
    this.parts.push(
      `<text x="${n(x)}" y="${n(y)}" font-size="${n(sizeMm)}" text-anchor="middle"${transform}>${escapeXml(content)}</text>`,
    );
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
        const sweep = (((endAngle - startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
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
    const gap = Math.min(Math.max(primitive.offset * this.paperPerUnit, 6), 14);
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
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle > 90 || angle <= -90) angle += 180;
    const radians = (angle * Math.PI) / 180;
    const middle: Vec2 = [
      (da[0] + db[0]) / 2 + Math.sin(radians) * 1.2,
      (da[1] + db[1]) / 2 - Math.cos(radians) * 1.2,
    ];
    this.text(middle, 2.5, primitive.label, angle);
  }
}

export interface PlanSheet {
  readonly filename: string;
  readonly svg: string;
  readonly paper: PaperSize;
  readonly scale: number;
  readonly levelId: string;
}

interface SheetOptions {
  readonly levelId?: string;
  readonly paper?: PaperSize;
  readonly scale?: number;
  readonly title?: string;
}

export function titleBlock(
  doc: CadDocument,
  sheet: { width: number; height: number; title: string; scale: number; paper: PaperSize },
): string {
  const { project } = getBuilding(doc);
  const width = Math.min(180, sheet.width - BINDING_MARGIN - MARGIN);
  const x = sheet.width - MARGIN - width;
  const y = sheet.height - MARGIN - TITLE_HEIGHT;
  const cell = (cx: number, cy: number, label: string, value: string, size = 3.2): string =>
    `<text x="${n(cx + 2)}" y="${n(cy + 3.5)}" font-size="2" class="label">${escapeXml(label)}</text>` +
    `<text x="${n(cx + 2)}" y="${n(cy + 9)}" font-size="${size}" text-anchor="start">${escapeXml(value)}</text>`;
  const column = width / 3;
  return [
    `<g id="title-block">`,
    `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${TITLE_HEIGHT}" class="frame"/>`,
    `<line x1="${n(x)}" y1="${n(y + 14)}" x2="${n(x + width)}" y2="${n(y + 14)}" class="frame-thin"/>`,
    `<line x1="${n(x)}" y1="${n(y + 28)}" x2="${n(x + width)}" y2="${n(y + 28)}" class="frame-thin"/>`,
    `<line x1="${n(x + column)}" y1="${n(y + 14)}" x2="${n(x + column)}" y2="${n(y + TITLE_HEIGHT)}" class="frame-thin"/>`,
    `<line x1="${n(x + 2 * column)}" y1="${n(y + 14)}" x2="${n(x + 2 * column)}" y2="${n(y + TITLE_HEIGHT)}" class="frame-thin"/>`,
    cell(x, y, 'PROJECT', project.name, 4.5),
    cell(x, y + 14, 'CLIENT', project.client || '—'),
    cell(x + column, y + 14, 'DRAWING', sheet.title),
    cell(x + 2 * column, y + 14, 'ADDRESS', project.address || '—', 2.6),
    cell(x, y + 28, 'DRAWN BY', project.author || '—'),
    cell(x + column, y + 28, 'SCALE · SHEET', `1:${sheet.scale} @ ${sheet.paper}`),
    cell(
      x + 2 * column,
      y + 28,
      'DWG NO · REV · DATE',
      `${project.drawingNumber} · ${project.revision} · ${project.date || '—'}`,
      2.8,
    ),
    `</g>`,
  ].join('');
}

function northArrow(x: number, y: number): string {
  return (
    `<g id="north-arrow"><circle cx="${n(x)}" cy="${n(y)}" r="6" class="frame-thin"/>` +
    `<polygon points="${n(x)},${n(y - 6)} ${n(x - 2.5)},${n(y + 3)} ${n(x)},${n(y + 1.5)} ${n(x + 2.5)},${n(y + 3)}" class="solid"/>` +
    `<text x="${n(x)}" y="${n(y - 7.5)}" font-size="3" text-anchor="middle">N</text></g>`
  );
}

export function scaleBar(x: number, y: number, scale: number): string {
  const stepsMetres = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  const step = stepsMetres.find((metres) => (metres * 1000) / scale >= 8) ?? 100;
  const stepMm = (step * 1000) / scale;
  const parts = [`<g id="scale-bar">`];
  for (let index = 0; index < 5; index++) {
    parts.push(
      `<rect x="${n(x + index * stepMm)}" y="${n(y)}" width="${n(stepMm)}" height="2" class="${index % 2 === 0 ? 'solid' : 'frame-thin'}"/>`,
    );
  }
  parts.push(
    `<text x="${n(x)}" y="${n(y + 5.5)}" font-size="2.4" text-anchor="middle">0</text>`,
    `<text x="${n(x + 5 * stepMm)}" y="${n(y + 5.5)}" font-size="2.4" text-anchor="middle">${n(5 * step)} m</text>`,
    `</g>`,
  );
  return parts.join('');
}

/** The drawing sheet envelope shared by every sheet export: frame, body group, scale bar, caption, title block. */
export function composeSheetSvg(
  doc: CadDocument,
  sheet: {
    width: number;
    height: number;
    title: string;
    scale: number;
    paper: PaperSize;
    caption: string;
    bodyId: string;
    body: string;
    /** Elements drawn after the body group and before the scale bar. */
    overlays: ReadonlyArray<string>;
  },
): string {
  const { width, height, title, scale, paper } = sheet;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escapeXml(title)}</title>`,
    SHEET_STYLE,
    SHEET_DEFS,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<rect x="${BINDING_MARGIN}" y="${MARGIN}" width="${width - BINDING_MARGIN - MARGIN}" height="${height - 2 * MARGIN}" class="frame"/>`,
    `<g id="${sheet.bodyId}">${sheet.body}</g>`,
    ...sheet.overlays,
    scaleBar(BINDING_MARGIN + 8, height - MARGIN - 12, scale),
    `<text x="${BINDING_MARGIN + 8}" y="${n(height - MARGIN - 16)}" font-size="2.6" text-anchor="start">${escapeXml(sheet.caption)}</text>`,
    titleBlock(doc, { width, height, title, scale, paper }),
    `</svg>`,
  ].join('\n');
}

/**
 * @pure
 * @failure unknown level, invalid paper or scale -> null
 */
function buildPlanSheet(doc: CadDocument, options: SheetOptions): PlanSheet | null {
  const drawing = buildPlanDrawing(doc, options.levelId);
  const paper = options.paper ?? 'A3';
  const size = PAPER_MM[paper];
  if (!drawing || !size) return null;
  if (options.scale !== undefined && !(Number.isFinite(options.scale) && options.scale > 0))
    return null;
  const [width, height] = size;
  const viewport = sheetDrawingArea(width, height);
  const millimetresPerUnit = toMetres(doc, 1) * 1000;
  const [minX, minY, maxX, maxY] = drawing.bounds;
  const scale =
    options.scale ??
    fitScale((maxX - minX) * millimetresPerUnit, (maxY - minY) * millimetresPerUnit, viewport);
  const painter = new SheetPainter(drawing, millimetresPerUnit / scale, viewport);
  for (const primitive of drawing.primitives) painter.paint(primitive);
  const title = options.title?.trim() || `${drawing.level.name} — Floor plan`;
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
    paper: z.enum(PAPER_SIZES).optional().describe('Paper size (landscape). Default A3.'),
    scale: z
      .number()
      .optional()
      .describe(
        'Scale denominator N for 1:N (e.g. 100). Default: smallest standard scale that fits.',
      ),
    title: z.string().optional().describe('Drawing title. Default "<level> — Floor plan".'),
  }),
  run: (doc, { levelId, paper, scale, title }): CommandResult => {
    const sheet = buildPlanSheet(doc, {
      ...(levelId !== undefined ? { levelId } : {}),
      ...(paper !== undefined ? { paper } : {}),
      ...(scale !== undefined ? { scale } : {}),
      ...(title !== undefined ? { title } : {}),
    });
    if (!sheet) {
      return noChange(
        doc,
        'export_plan_sheet failed: no such level (add_level / add_wall first) or invalid scale (must be > 0).',
      );
    }
    return {
      document: doc,
      summary: `Plan sheet ${sheet.filename}: level ${sheet.levelId} at 1:${sheet.scale} on ${sheet.paper}.`,
      affected: [],
      data: sheet,
    };
  },
});
