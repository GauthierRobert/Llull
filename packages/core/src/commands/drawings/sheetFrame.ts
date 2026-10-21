/** Sheet envelope: ISO paper frame, title block, stylesheet and the drawing area the views are laid out in. */

import { LINE_PATTERNS, dashArray } from '../../model/drawing';
import { type DrawingSheet, PAPER_MM } from '../../model/sheet';
import { escapeXml } from '../../lib/escapeXml';
import type { Area } from './layout';
import {
  SHEET_BINDING_MARGIN,
  SHEET_MARGIN,
  sheetDrawingArea,
  sheetFrameRect,
  titleBlockGrid,
  titleCell,
} from '../../geometry/sheetLayout';
import { scaleText } from './sheetOps';

/** Drawing area of a sheet: inside the frame, above the title block. @pure */
export function sheetArea(paper: DrawingSheet['paper']): Area {
  const [width, height] = PAPER_MM[paper];
  return sheetDrawingArea(width, height);
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
  const { x, y, column, lines } = titleBlockGrid(paperWidth, paperHeight);
  const { title, partNumber, drawnBy, revision, date } = sheet.titleBlock;
  const angle = sheet.projectionAngle === 'first' ? 'FIRST ANGLE' : 'THIRD ANGLE';
  return [
    `<g id="title-block">`,
    ...lines,
    titleCell(x, y, 'TITLE', title || sheet.name, 4.5),
    titleCell(x, y + 14, 'PART NUMBER', partNumber || '—'),
    titleCell(x + column, y + 14, 'SHEET', sheet.name, 2.8),
    titleCell(x + 2 * column, y + 14, 'PROJECTION', angle, 2.8),
    titleCell(x, y + 28, 'DRAWN BY', drawnBy || '—'),
    titleCell(x + column, y + 28, 'SCALE · PAPER', `${scaleText(scale)} @ ${sheet.paper}`),
    titleCell(x + 2 * column, y + 28, 'REV · DATE', `${revision || '—'} · ${date || '—'}`, 2.8),
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
    sheetFrameRect(width, height),
    body,
    titleBlock(sheet, scale),
    ...(notice === undefined
      ? []
      : [
          `<text id="export-marking" x="${SHEET_BINDING_MARGIN + 2}" y="${height - SHEET_MARGIN - 2}" font-size="3" font-weight="bold">${escapeXml(notice)}</text>`,
        ]),
    `</svg>`,
  ].join('\n');
}
