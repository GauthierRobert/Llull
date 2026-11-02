/** SVG and DXF R12 text of the plan symbols (06 STA §6): the same primitive list printed twice, fixed-format numbers, no clock. Model space in mm, 1:1. */

import { n, svgText } from '@core/geometry/drawingSvg';
import type { Vec2 } from '@core/model/types';
import { DxfWriter, assembleDxf } from '@lib/dxfWriter';
import { escapeXml } from '@lib/escapeXml';
import type { PlanLayer, PlanPrimitive } from './planSymbols';

const MARGIN_MM = 500;

/** AutoCAD colour index per layer. */
const COLOURS: Readonly<Record<PlanLayer, number>> = {
  'S-PLAT': 3,
  'S-GRAT': 8,
  'S-LADR': 5,
  'S-STAR': 6,
  'S-RAIL': 1,
  'S-GATE': 2,
  'S-TEXT': 7,
};

const STROKE: Readonly<Record<PlanLayer, string>> = {
  'S-PLAT': '#1b7f3b',
  'S-GRAT': '#888888',
  'S-LADR': '#1f5fbf',
  'S-STAR': '#a33fa3',
  'S-RAIL': '#cc2222',
  'S-GATE': '#d9a400',
  'S-TEXT': '#000000',
};

const STYLE =
  `${(Object.keys(STROKE) as PlanLayer[]).map((layer) => `.${layer}{fill:none;stroke:${STROKE[layer]};stroke-width:12}`).join('')}` +
  '.S-GATE{stroke-dasharray:60 40}.S-TEXT{fill:#000;stroke:none}';

function extent(primitives: readonly PlanPrimitive[]): { min: Vec2; max: Vec2 } {
  const points = primitives.flatMap((primitive): Vec2[] => {
    switch (primitive.t) {
      case 'line':
        return [primitive.a, primitive.b];
      case 'poly':
        return [...primitive.points];
      case 'circle':
        return [
          [primitive.c[0] - primitive.r, primitive.c[1] - primitive.r],
          [primitive.c[0] + primitive.r, primitive.c[1] + primitive.r],
        ];
      case 'text':
        return [primitive.at, [primitive.at[0] + primitive.size * primitive.text.length * 0.6, primitive.at[1] + primitive.size]];
    }
  });
  if (points.length === 0) return { min: [0, 0], max: [0, 0] };
  return {
    min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))],
    max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))],
  };
}

/** SVG of the primitives: viewBox = the drawing extent plus a 500 mm margin (y flipped so +y is up); one class per layer. */
export function planSvg(primitives: readonly PlanPrimitive[], title: string): { svg: string; widthMm: number; heightMm: number } {
  const { min, max } = extent(primitives);
  const [x0, y1] = [min[0] - MARGIN_MM, max[1] + MARGIN_MM];
  const widthMm = Math.round(max[0] - min[0] + 2 * MARGIN_MM);
  const heightMm = Math.round(max[1] - min[1] + 2 * MARGIN_MM);
  const at = (point: Vec2): string => `${n(point[0])},${n(-point[1])}`;
  const body = primitives.map((primitive): string => {
    switch (primitive.t) {
      case 'line':
        return `<line x1="${n(primitive.a[0])}" y1="${n(-primitive.a[1])}" x2="${n(primitive.b[0])}" y2="${n(-primitive.b[1])}" class="${primitive.layer}"/>`;
      case 'poly':
        return `<${primitive.closed ? 'polygon' : 'polyline'} points="${primitive.points.map(at).join(' ')}" class="${primitive.layer}"/>`;
      case 'circle':
        return `<circle cx="${n(primitive.c[0])}" cy="${n(-primitive.c[1])}" r="${n(primitive.r)}" class="${primitive.layer}"/>`;
      case 'text':
        return svgText(primitive.at[0], -primitive.at[1], primitive.size, 'start', primitive.text).replace(
          '<text ',
          `<text class="${primitive.layer}" `,
        );
    }
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="${n(x0)} ${n(-y1)} ${widthMm} ${heightMm}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escapeXml(title)}</title>`,
    `<style>${STYLE}</style>`,
    ...body,
    '</svg>',
  ].join('\n');
  return { svg: `${svg}\n`, widthMm, heightMm };
}

/** DXF R12 of the primitives, units mm, layers S-PLAT / S-GRAT / S-LADR / S-STAR / S-RAIL / S-GATE / S-TEXT. */
export function planDxf(primitives: readonly PlanPrimitive[]): string {
  const writer = new DxfWriter(COLOURS);
  for (const primitive of primitives) {
    switch (primitive.t) {
      case 'line':
        writer.line(primitive.layer, primitive.a, primitive.b);
        break;
      case 'poly':
        writer.polyline(primitive.layer, primitive.points, primitive.closed);
        break;
      case 'circle':
        writer.circle(primitive.layer, primitive.c, primitive.r);
        break;
      case 'text':
        writer.text(primitive.layer, primitive.at, primitive.size, primitive.text, 'left');
        break;
    }
  }
  return `${assembleDxf('mm', writer)}\n`;
}
