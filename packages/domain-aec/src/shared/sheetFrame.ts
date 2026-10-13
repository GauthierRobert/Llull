/**
 * Drawing-sheet envelope shared by building, industrial and civil sheets: ISO paper, scale fitting,
 * frame, title block, north arrow, scale bar.
 * @layer domain-aec/shared
 * @pure
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { LINE_PATTERNS, dashArray } from '@core/model/drawing';
import { z } from '@core/commands/schema';
import { readableAngle, toDegrees } from '@lib/angle';
import { escapeXml } from '@lib/escapeXml';
import { niceStep } from '@lib/niceStep';
import { getBuilding } from '../building/model';
import { round } from './numeric';

export const PAPER_SIZES = ['A4', 'A3', 'A2', 'A1', 'A0'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/** `paper` parameter shared by the drawing-sheet commands. */
export const PAPER_FIELD = z.enum(PAPER_SIZES).optional().describe('Paper size (landscape). Default A3.');

/** `scale` parameter of the building drawing sheets (plan, elevation). */
export const SCALE_FIELD = z
  .number()
  .optional()
  .describe('Scale denominator N for 1:N (e.g. 100). Default: the smallest standard scale that fits (1-2-5 steps beyond 1:2000).');

/** Warning appended to a sheet summary when `what` is larger than the paper at the chosen scale. */
export const sheetFitWarning = (fits: boolean, what: string): string =>
  fits ? '' : ` WARNING: the ${what} is larger than the paper at this scale; omit scale to auto-fit or choose a larger paper.`;

/** Landscape ISO 216 sizes, millimetres. */
export const PAPER_MM: Readonly<Record<PaperSize, readonly [number, number]>> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
};

const STANDARD_SCALES: ReadonlyArray<number> = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

export const MARGIN = 10;
const BINDING_MARGIN = 20;
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

/** SVG number text: two decimals, no trailing zeros. */
export const n = (value: number): string => String(round(value));

/** SVG points attribute text: `x,y` pairs joined by spaces. */
export const svgPoints = (points: ReadonlyArray<readonly [number, number]>): string =>
  points.map((point) => point.map(n).join(',')).join(' ');

/** Model point to paper mm: `center` lands at the viewport middle, +Y flipped, `perUnit` paper mm per model unit. */
export const paperMap =
  (viewport: Viewport, center: Vec2, perUnit: number) =>
  ([x, y]: Vec2): Vec2 => [
    viewport.x + viewport.width / 2 + (x - center[0]) * perUnit,
    viewport.y + viewport.height / 2 - (y - center[1]) * perUnit,
  ];

/**
 * Dimension label placement: text angle (degrees, flipped to read left-to-right / bottom-up) for a
 * baseline direction (`dx`, `dy`), and the label anchor 1.2 mm off the midpoint of the dimension line `da`-`db`.
 */
export function readableDimensionLabel(da: Vec2, db: Vec2, dx: number, dy: number): { readonly angle: number; readonly middle: Vec2 } {
  const radians = readableAngle(Math.atan2(dy, dx));
  return {
    angle: toDegrees(radians),
    middle: [(da[0] + db[0]) / 2 + Math.sin(radians) * 1.2, (da[1] + db[1]) / 2 - Math.cos(radians) * 1.2],
  };
}

/** SVG `<text>` at paper point (`x`, `y`), content XML-escaped; optional rotation about the anchor point. */
export const svgText = (
  x: number,
  y: number,
  size: number,
  anchor: 'start' | 'middle' | 'end',
  content: string,
  rotationDeg = 0,
): string => {
  const transform = rotationDeg !== 0 ? ` transform="rotate(${n(rotationDeg)} ${n(x)} ${n(y)})"` : '';
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" text-anchor="${anchor}"${transform}>${escapeXml(content)}</text>`;
};

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Smallest standard scale 1:N at which the model extents fit the viewport. */
export function fitScale(widthMm: number, heightMm: number, viewport: Viewport): number {
  for (const scale of STANDARD_SCALES) {
    if (widthMm / scale <= viewport.width * 0.92 && heightMm / scale <= viewport.height * 0.92) return scale;
  }
  // Beyond the standard scales: the next 1-2-5 step that fits, so the sheet never overflows.
  const largest = STANDARD_SCALES[STANDARD_SCALES.length - 1] as number;
  const needed = Math.max(widthMm / (viewport.width * 0.92), heightMm / (viewport.height * 0.92));
  if (!(needed > largest) || !Number.isFinite(needed)) return largest;
  return niceStep(needed);
}

/** Shared drawing-sheet stylesheet (line weights in paper millimetres). */
const SHEET_STYLE = [
  `<style>`,
  `.cut{fill:#4a4a4a;stroke:#000;stroke-width:0.35}.cut-line{fill:none;stroke:#000;stroke-width:0.35}`,
  `.thin{fill:none;stroke:#000;stroke-width:0.18}.hidden{fill:none;stroke:#000;stroke-width:0.18;stroke-dasharray:${dashArray(LINE_PATTERNS.hidden, 0.75)}}.center{fill:none;stroke:#000;stroke-width:0.18;stroke-dasharray:${dashArray(LINE_PATTERNS.center, 1)}}`,
  `.dim{stroke:#000;stroke-width:0.13}.frame{fill:none;stroke:#000;stroke-width:0.5}.frame-thin{fill:none;stroke:#000;stroke-width:0.25}`,
  `.solid{fill:#000;stroke:#000;stroke-width:0.25}.label{fill:#555}text{fill:#000}`,
  `.cut-hatch{fill:url(#hatch-concrete);stroke:#000;stroke-width:0.35}`,
  `</style>`,
].join('');

/** Shared fill patterns: ANSI31-style 45° hatch for concrete / masonry cuts. */
const SHEET_DEFS =
  `<defs><pattern id="hatch-concrete" width="1.5" height="1.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
  `<rect width="1.5" height="1.5" fill="#d9d9d9"/><line x1="0" y1="0" x2="0" y2="1.5" stroke="#000" stroke-width="0.12"/></pattern></defs>`;

function titleBlock(doc: CadDocument, sheet: { width: number; height: number; title: string; scale: number; paper: PaperSize }): string {
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
    cell(x + 2 * column, y + 28, 'DWG NO · REV · DATE', `${project.drawingNumber} · ${project.revision} · ${project.date || '—'}`, 2.8),
    `</g>`,
  ].join('');
}

export function northArrow(x: number, y: number): string {
  return (
    `<g id="north-arrow"><circle cx="${n(x)}" cy="${n(y)}" r="6" class="frame-thin"/>` +
    `<polygon points="${n(x)},${n(y - 6)} ${n(x - 2.5)},${n(y + 3)} ${n(x)},${n(y + 1.5)} ${n(x + 2.5)},${n(y + 3)}" class="solid"/>` +
    `<text x="${n(x)}" y="${n(y - 7.5)}" font-size="3" text-anchor="middle">N</text></g>`
  );
}

/** A length in metres as scale-bar text: millimetres below 1 m ("5 mm", "250 mm"), metres above. */
function lengthLabel(metres: number): string {
  return metres < 1 ? `${Number((metres * 1000).toPrecision(6))} mm` : `${Number(metres.toPrecision(6))} m`;
}

function scaleBar(x: number, y: number, scale: number): string {
  // A 1-2-5 step of at least 8 paper mm: millimetres for machine parts, up to kilometres for sites.
  const step = niceStep((8 * scale) / 1000);
  const stepMm = (step * 1000) / scale;
  const parts = [`<g id="scale-bar">`];
  for (let index = 0; index < 5; index++) {
    parts.push(
      `<rect x="${n(x + index * stepMm)}" y="${n(y)}" width="${n(stepMm)}" height="2" class="${index % 2 === 0 ? 'solid' : 'frame-thin'}"/>`,
    );
  }
  parts.push(
    `<text x="${n(x)}" y="${n(y + 5.5)}" font-size="2.4" text-anchor="middle">0</text>`,
    `<text x="${n(x + 5 * stepMm)}" y="${n(y + 5.5)}" font-size="2.4" text-anchor="middle">${lengthLabel(5 * step)}</text>`,
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
    /** Extra CSS appended after the shared sheet style. */
    style?: string;
    /** Elements drawn after the body group and before the scale bar. */
    overlays: ReadonlyArray<string>;
  },
): string {
  const { width, height, title, scale, paper } = sheet;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escapeXml(title)}</title>`,
    SHEET_STYLE,
    ...(sheet.style ? [`<style>${sheet.style}</style>`] : []),
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
