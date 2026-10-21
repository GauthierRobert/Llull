/** Drawing-sheet geometry shared by the core and plugin sheet frames: margins, drawing area, frame rectangle and title-block grid (paper mm). */

import { escapeXml } from '../lib/escapeXml';
import { n } from './drawingSvg';

export const SHEET_MARGIN = 10;
export const SHEET_BINDING_MARGIN = 20;
export const SHEET_TITLE_HEIGHT = 42;

export interface SheetArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Drawing area of a `width`×`height` mm sheet: inside the frame margins, above the title block. @pure */
export function sheetDrawingArea(width: number, height: number): SheetArea {
  return {
    x: SHEET_BINDING_MARGIN + 4,
    y: SHEET_MARGIN + 4,
    width: width - SHEET_BINDING_MARGIN - SHEET_MARGIN - 8,
    height: height - 2 * SHEET_MARGIN - SHEET_TITLE_HEIGHT - 8,
  };
}

/** The sheet border rectangle (class `frame`), inset by the binding margin on the left. */
export const sheetFrameRect = (width: number, height: number): string =>
  `<rect x="${SHEET_BINDING_MARGIN}" y="${SHEET_MARGIN}" width="${width - SHEET_BINDING_MARGIN - SHEET_MARGIN}" height="${height - 2 * SHEET_MARGIN}" class="frame"/>`;

/** One title-block cell: small label above a value. */
export const titleCell = (cx: number, cy: number, label: string, value: string, size = 3.2): string =>
  `<text x="${n(cx + 2)}" y="${n(cy + 3.5)}" font-size="2" class="label">${escapeXml(label)}</text>` +
  `<text x="${n(cx + 2)}" y="${n(cy + 9)}" font-size="${size}" text-anchor="start">${escapeXml(value)}</text>`;

export interface TitleBlockGrid {
  /** Bottom-right origin and width of the block, and the width of one of its three columns. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly column: number;
  /** Outer rectangle plus the two row rules and two column rules, in paint order. */
  readonly lines: readonly string[];
}

/** Geometry and ruling of the three-column, three-row title block at the bottom right of a `width`×`height` mm sheet. */
export function titleBlockGrid(width: number, height: number): TitleBlockGrid {
  const blockWidth = Math.min(180, width - SHEET_BINDING_MARGIN - SHEET_MARGIN);
  const x = width - SHEET_MARGIN - blockWidth;
  const y = height - SHEET_MARGIN - SHEET_TITLE_HEIGHT;
  const column = blockWidth / 3;
  const rule = (x1: number, y1: number, x2: number, y2: number): string =>
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" class="frame-thin"/>`;
  return {
    x,
    y,
    width: blockWidth,
    column,
    lines: [
      `<rect x="${n(x)}" y="${n(y)}" width="${n(blockWidth)}" height="${SHEET_TITLE_HEIGHT}" class="frame"/>`,
      rule(x, y + 14, x + blockWidth, y + 14),
      rule(x, y + 28, x + blockWidth, y + 28),
      rule(x + column, y + 14, x + column, y + SHEET_TITLE_HEIGHT),
      rule(x + 2 * column, y + 14, x + 2 * column, y + SHEET_TITLE_HEIGHT),
    ],
  };
}
