/** Sheet envelope: ISO paper frame, title block, stylesheet and the drawing area the views are laid out in. */

import { LINE_PATTERNS, dashArray } from '../../model/drawing';
import { type DrawingSheet, PAPER_MM } from '../../model/sheet';
import { escapeXml } from '../../lib/escapeXml';
import type { Area } from './layout';
import { n } from '../../geometry/drawingSvg';
import { scaleText } from './sheetOps';

const MARGIN = 10;
const BINDING_MARGIN = 20;
const TITLE_HEIGHT = 42;

/** Drawing area of a sheet: inside the frame, above the title block. @pure */
export function sheetArea(paper: DrawingSheet['paper']): Area {
  const [width, height] = PAPER_MM[paper];
  return {
    x: BINDING_MARGIN + 4,
    y: MARGIN + 4,
    width: width - BINDING_MARGIN - MARGIN - 8,
    height: height - 2 * MARGIN - TITLE_HEIGHT - 8,
  };
}

/** Sheet stylesheet: line weights in paper millimetres (ISO 128 thick / thin pairs). */
const STYLE =
  `<style>.cut-line{fill:none;stroke:#000;stroke-width:0.5}.cut{fill:#4a4a4a;stroke:#000;stroke-width:0.5}` +
  `.thin{fill:none;stroke:#000;stroke-width:0.25}.hidden{fill:none;stroke:#000;stroke-width:0.25;stroke-dasharray:${dashArray(LINE_PATTERNS.hidden, 0.75)}}` +
  `.center{fill:none;stroke:#000;stroke-width:0.25;stroke-dasharray:${dashArray(LINE_PATTERNS.center, 1)}}` +
  `.dim{stroke:#000;stroke-width:0.18}.frame{fill:none;stroke:#000;stroke-width:0.7}.frame-thin{fill:none;stroke:#000;stroke-width:0.25}` +
  `.cut-hatch{fill:url(#hatch);stroke:#000;stroke-width:0.5}.plane{fill:none;stroke:#000;stroke-width:0.5;stroke-dasharray:${dashArray(LINE_PATTERNS.center, 1.5)}}` +
  `.solid{fill:#000;stroke:#000;stroke-width:0.25}.label{fill:#555}text{fill:#000}</style>`;

/** ANSI31 45° hatch of cut faces. */
const HATCH =
  `<pattern id="hatch" width="1.5" height="1.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
  `<rect width="1.5" height="1.5" fill="#d9d9d9"/><line x1="0" y1="0" x2="0" y2="1.5" stroke="#000" stroke-width="0.12"/></pattern>`;

function titleBlock(sheet: DrawingSheet, scale: number): string {
  const [paperWidth, paperHeight] = PAPER_MM[sheet.paper];
  const width = Math.min(180, paperWidth - BINDING_MARGIN - MARGIN);
  const [x, y] = [paperWidth - MARGIN - width, paperHeight - MARGIN - TITLE_HEIGHT];
  const column = width / 3;
  const { title, partNumber, drawnBy, revision, date } = sheet.titleBlock;
  const cell = (cx: number, cy: number, label: string, value: string, size = 3.2): string =>
    `<text x="${n(cx + 2)}" y="${n(cy + 3.5)}" font-size="2" class="label">${escapeXml(label)}</text>` +
    `<text x="${n(cx + 2)}" y="${n(cy + 9)}" font-size="${size}" text-anchor="start">${escapeXml(value)}</text>`;
  const rule = (x1: number, y1: number, x2: number, y2: number): string =>
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" class="frame-thin"/>`;
  const angle = sheet.projectionAngle === 'first' ? 'FIRST ANGLE' : 'THIRD ANGLE';
  return [
    `<g id="title-block">`,
    `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${TITLE_HEIGHT}" class="frame"/>`,
    rule(x, y + 14, x + width, y + 14),
    rule(x, y + 28, x + width, y + 28),
    rule(x + column, y + 14, x + column, y + TITLE_HEIGHT),
    rule(x + 2 * column, y + 14, x + 2 * column, y + TITLE_HEIGHT),
    cell(x, y, 'TITLE', title || sheet.name, 4.5),
    cell(x, y + 14, 'PART NUMBER', partNumber || '—'),
    cell(x + column, y + 14, 'SHEET', sheet.name, 2.8),
    cell(x + 2 * column, y + 14, 'PROJECTION', angle, 2.8),
    cell(x, y + 28, 'DRAWN BY', drawnBy || '—'),
    cell(x + column, y + 28, 'SCALE · PAPER', `${scaleText(scale)} @ ${sheet.paper}`),
    cell(x + 2 * column, y + 28, 'REV · DATE', `${revision || '—'} · ${date || '—'}`, 2.8),
    `</g>`,
  ].join('');
}

/** The complete sheet document around the already-painted `body` (view groups) and `defs` (clip paths); `notice` = export-control statement for the frame. */
export function composeSheet(sheet: DrawingSheet, scale: number, body: string, defs: string, notice?: string): string {
  const [width, height] = PAPER_MM[sheet.paper];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escapeXml(sheet.titleBlock.title || sheet.name)}</title>`,
    STYLE,
    `<defs>${HATCH}${defs}</defs>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<rect x="${BINDING_MARGIN}" y="${MARGIN}" width="${width - BINDING_MARGIN - MARGIN}" height="${height - 2 * MARGIN}" class="frame"/>`,
    body,
    titleBlock(sheet, scale),
    ...(notice === undefined
      ? []
      : [
          `<text id="export-marking" x="${BINDING_MARGIN + 2}" y="${height - MARGIN - 2}" font-size="3" font-weight="bold">${escapeXml(notice)}</text>`,
        ]),
    `</svg>`,
  ].join('\n');
}
