/** SVG of a P&ID sheet (plant 04 PID FR-PID-62): paper frame and title block of the shared sheet layout, one `<g id="<item id>">` per item. Deterministic. */

import { LINE_PATTERNS, dashArray, drawingBounds } from '@core/model/drawing';
import { DrawingPainter, n } from '@core/geometry/drawingSvg';
import { sheetFrameRect, titleBlockGrid, titleCell } from '@core/geometry/sheetLayout';
import { PAPER_MM } from '@core/model/sheet';
import type { Vec2 } from '@core/model/vectors';
import { escapeXml } from '@lib/escapeXml';
import { xmlValue } from '../export/xmlWrite';
import type { PidDrawing } from './pidDrawing';
import { clip } from './placeSymbol';

const STYLE =
  `<style>.frame{fill:none;stroke:#000;stroke-width:.5}.frame-thin{fill:none;stroke:#000;stroke-width:.25}.label{fill:#555}text{fill:#000}` +
  `.cut-line{fill:none;stroke:#000;stroke-width:.35}.thin{fill:none;stroke:#000;stroke-width:.18}` +
  `.hidden{fill:none;stroke:#000;stroke-width:.18;stroke-dasharray:${dashArray(LINE_PATTERNS.hidden, 0.75)}}` +
  `.center{fill:none;stroke:#000;stroke-width:.18;stroke-dasharray:${dashArray(LINE_PATTERNS.center, 1)}}` +
  `.cut{fill:#000;stroke:#000;stroke-width:.25}.PID-PIPE .cut-line{stroke-width:.6}.PID-SIGN .thin,.PID-SIGN .hidden,.PID-SIGN .center{stroke-width:.25}</style>`;

export interface PidSvg {
  readonly svg: string;
  readonly widthMm: number;
  readonly heightMm: number;
  /** Items whose glyph lies partly outside the paper (the view box grows to keep them). */
  readonly outside: number;
}

/** `scale` = output millimetres per sheet millimetre. */
export function pidSvg(drawing: PidDrawing, scale: number): PidSvg {
  const { sheet } = drawing;
  const [paperW, paperH] = PAPER_MM[sheet.paper];
  const flip = (p: Vec2): Vec2 => [p[0], paperH - p[1]];
  const painter = new DrawingPainter(flip, 1);
  let minX = 0;
  let minY = 0;
  let maxX = paperW;
  let maxY = paperH;
  let outside = 0;
  const groups = drawing.glyphs.map((glyph) => {
    const [x0, y0, x1, y1] = drawingBounds(glyph.primitives);
    if (glyph.primitives.length > 0 && (x0 < 0 || y0 < 0 || x1 > paperW || y1 > paperH)) outside++;
    if (glyph.primitives.length > 0) {
      minX = Math.min(minX, x0 - 2);
      maxX = Math.max(maxX, x1 + 2);
      minY = Math.min(minY, paperH - y1 - 2);
      maxY = Math.max(maxY, paperH - y0 + 2);
    }
    painter.parts.length = 0;
    for (const primitive of glyph.primitives) painter.paint(primitive);
    const tag = glyph.tag === undefined ? '' : ` data-tag="${xmlValue(clip(glyph.tag))}"`;
    return `<g id="${xmlValue(glyph.id)}" class="${glyph.layer}" data-kind="${glyph.kind}"${tag}>${painter.parts.join('')}</g>`;
  });
  const width = maxX - minX;
  const height = maxY - minY;
  const { x, y, column, lines } = titleBlockGrid(paperW, paperH);
  const title = [
    '<g id="title-block">',
    ...lines,
    titleCell(x, y, 'DRAWING', clip(sheet.title), 3.6),
    titleCell(x, y + 14, 'SHEET', sheet.number),
    titleCell(x + column, y + 14, 'REVISION', sheet.revision),
    titleCell(x + 2 * column, y + 14, 'STATUS', sheet.status.replace(/_/g, ' ')),
    titleCell(x, y + 28, 'SCALE', 'NOT TO SCALE'),
    titleCell(x + column, y + 28, 'PAPER', sheet.paper),
    titleCell(x + 2 * column, y + 28, 'CONVENTION', drawing.convention),
    '</g>',
  ];
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width * scale)}mm" height="${n(height * scale)}mm" viewBox="${n(minX)} ${n(minY)} ${n(width)} ${n(height)}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escapeXml(clip(`${sheet.number} ${sheet.title}`))}</title>`,
    STYLE,
    `<rect x="${n(minX)}" y="${n(minY)}" width="${n(width)}" height="${n(height)}" fill="#fff"/>`,
    sheetFrameRect(paperW, paperH),
    `<g id="pid-sheet" data-sheet="${xmlValue(sheet.number)}">`,
    ...groups,
    '</g>',
    ...title,
    '</svg>',
  ].join('\n');
  return { svg, widthMm: Math.round(width * scale * 100) / 100, heightMm: Math.round(height * scale * 100) / 100, outside };
}
