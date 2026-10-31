/**
 * Isometric sheet output (plant 05 ISO §6.2): the drawing is a list of primitives in paper millimetres (x right, y up) on the layers ISO-PIPE, ISO-SYMB, ISO-DIM,
 * ISO-TEXT, ISO-TABLE, ISO-FRAME; `svgOf` and `dxfOf` print the same list, so both formats carry the same geometry. Numbers are fixed-format, no clock, so the
 * bytes depend only on the input. Pure.
 */

import { n, svgText } from '@core/geometry/drawingSvg';
import type { Vec2 } from '@core/model/vectors';
import { DxfWriter, assembleDxf } from '@lib/dxfWriter';
import { escapeXml } from '@lib/escapeXml';

export type IsoLayer = 'ISO-PIPE' | 'ISO-SYMB' | 'ISO-DIM' | 'ISO-TEXT' | 'ISO-TABLE' | 'ISO-FRAME';

export type IsoPrimitive =
  | { readonly t: 'line'; readonly layer: IsoLayer; readonly a: Vec2; readonly b: Vec2; readonly gap?: true }
  | { readonly t: 'poly'; readonly layer: IsoLayer; readonly points: readonly Vec2[]; readonly closed: boolean; readonly fill?: true }
  | { readonly t: 'circle'; readonly layer: IsoLayer; readonly c: Vec2; readonly r: number; readonly fill?: true }
  | {
      readonly t: 'text';
      readonly layer: IsoLayer;
      readonly at: Vec2;
      readonly size: number;
      readonly text: string;
      readonly anchor: 'start' | 'middle' | 'end';
      readonly rotation?: number;
    };

const CLASS: Readonly<Record<IsoLayer, string>> = {
  'ISO-PIPE': 'iso-pipe',
  'ISO-SYMB': 'iso-symb',
  'ISO-DIM': 'iso-dim',
  'ISO-TEXT': 'iso-text',
  'ISO-TABLE': 'iso-table',
  'ISO-FRAME': 'iso-frame',
};

const STYLE =
  '.iso-pipe{fill:none;stroke:#000;stroke-width:0.5}.iso-symb{fill:none;stroke:#000;stroke-width:0.3}.iso-dim{fill:none;stroke:#000;stroke-width:0.13}' +
  '.iso-table{fill:none;stroke:#000;stroke-width:0.15}.iso-frame{fill:none;stroke:#000;stroke-width:0.4}.iso-gap{stroke:#fff;stroke-width:1.6}' +
  '.iso-fill{fill:#000}text{fill:#000}';

/** SVG document of a sheet of `width` x `height` mm. */
export function svgOf(primitives: readonly IsoPrimitive[], width: number, height: number, title: string): string {
  const flip = (point: Vec2): string => `${n(point[0])},${n(height - point[1])}`;
  const body = primitives.map((primitive): string => {
    const css = CLASS[primitive.layer];
    switch (primitive.t) {
      case 'line':
        return `<line x1="${n(primitive.a[0])}" y1="${n(height - primitive.a[1])}" x2="${n(primitive.b[0])}" y2="${n(height - primitive.b[1])}" class="${primitive.gap === true ? 'iso-gap' : css}"/>`;
      case 'poly':
        return `<${primitive.closed ? 'polygon' : 'polyline'} points="${primitive.points.map(flip).join(' ')}" class="${css}${primitive.fill === true ? ' iso-fill' : ''}"/>`;
      case 'circle':
        return `<circle cx="${n(primitive.c[0])}" cy="${n(height - primitive.c[1])}" r="${n(primitive.r)}" class="${css}${primitive.fill === true ? ' iso-fill' : ''}"/>`;
      case 'text':
        return svgText(
          primitive.at[0],
          height - primitive.at[1],
          primitive.size,
          primitive.anchor,
          primitive.text,
          -(primitive.rotation ?? 0),
        );
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escapeXml(title)}</title>`,
    `<style>${STYLE}</style>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

const LAYER_COLORS: Readonly<Record<string, number>> = {
  'ISO-PIPE': 7,
  'ISO-SYMB': 1,
  'ISO-DIM': 3,
  'ISO-TEXT': 7,
  'ISO-TABLE': 8,
  'ISO-FRAME': 7,
};

const ANCHOR = { start: 'left', middle: 'center', end: 'right' } as const;

/** DXF R12 text of the same primitives (layers as named above, mm). Gap breaks are not drawn in DXF. */
export function dxfOf(primitives: readonly IsoPrimitive[]): string {
  const writer = new DxfWriter(LAYER_COLORS);
  for (const primitive of primitives) {
    switch (primitive.t) {
      case 'line':
        if (primitive.gap !== true) writer.line(primitive.layer, primitive.a, primitive.b);
        break;
      case 'poly':
        writer.polyline(primitive.layer, primitive.points, primitive.closed);
        break;
      case 'circle':
        writer.circle(primitive.layer, primitive.c, primitive.r);
        break;
      case 'text':
        writer.text(primitive.layer, primitive.at, primitive.size, primitive.text, ANCHOR[primitive.anchor], primitive.rotation ?? 0);
        break;
    }
  }
  return `${assembleDxf('mm', writer)}\n`;
}
