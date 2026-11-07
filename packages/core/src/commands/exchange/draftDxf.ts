/** Drafting shapes as R2000 DXF entities (the mapping behind `export_dxf`). */

import type { Dxf2000Writer, DxfStyle } from '../../lib/dxf2000';
import { loopDepths } from '../../geometry/region';
import type { DraftItem, DraftShape } from './draftExport';

type Spline = Extract<DraftShape, { kind: 'spline' }>;

/** Knots of the piecewise-Bézier degree-3 B-spline through `count` Bézier segments (interior knots of multiplicity 3, clamped ends). */
const bezierKnots = (count: number): number[] => [
  0,
  0,
  0,
  0,
  ...Array.from({ length: count - 1 }, (_, i) => [i + 1, i + 1, i + 1]).flat(),
  count,
  count,
  count,
  count,
];

function writeSpline(writer: Dxf2000Writer, style: DxfStyle, shape: Spline, z: number): void {
  const [first] = shape.beziers;
  if (first === undefined) return;
  const controls = [first[0], ...shape.beziers.flatMap(([, c1, c2, end]) => [c1, c2, end])];
  const points = shape.points.map(([x, y]): readonly [number, number, number] => [x, y, z]);
  writer.spline(style, bezierKnots(shape.beziers.length), controls, shape.closed, z, {
    tag: 'spline',
    ints: [shape.closed ? 1 : 0],
    points,
  });
}

/** Writes one item; an entity colour equal to its layer's (case-insensitive hex) is left by layer. */
export function writeDraftItem(writer: Dxf2000Writer, item: DraftItem): void {
  const layer = writer.declareLayer(item.layerName, { color: item.layerColor, visible: item.visible, locked: item.locked });
  const byLayer = item.layerColor !== null && item.layerColor.toLowerCase() === item.color.toLowerCase();
  const style: DxfStyle = { layer, color: byLayer ? null : item.color };
  const { shape, z } = item;
  switch (shape.kind) {
    case 'line':
      return writer.line(style, shape.a, shape.b, z);
    case 'polyline':
      return writer.polyline(style, shape.points, shape.closed, z, shape.rectangle ? { tag: 'rectangle' } : undefined);
    case 'arc':
      return writer.arc(style, shape.center, shape.radius, shape.start, shape.end, z);
    case 'circle':
      return writer.circle(style, shape.center, shape.radius, z);
    case 'ellipse':
      return writer.ellipse(style, shape.center, shape.major, shape.ratio, z);
    case 'spline':
      return writeSpline(writer, style, shape, z);
    case 'point':
      return writer.point(style, shape.at, z);
    case 'text':
      if (/[\r\n]/.test(shape.content)) return writer.mtext(style, shape.at, shape.height, shape.content, shape.anchor, shape.rotation, z);
      return writer.text(style, shape.at, shape.height, shape.content, shape.anchor, shape.rotation, z);
    case 'region':
      if (shape.hatch !== null) {
        const { pattern, angle, spacing } = shape.hatch;
        const fill =
          pattern === 'solid' ? ({ kind: 'solid' } as const) : ({ kind: 'lines', angle, spacing, cross: pattern === 'cross' } as const);
        return writer.hatch(
          style,
          shape.loops,
          fill,
          z,
          loopDepths(shape.loops).map((depth) => depth === 0),
        );
      }
      for (const loop of shape.loops) writer.polyline(style, loop, true, z, { tag: 'region', ints: [shape.ordinal] });
  }
}
