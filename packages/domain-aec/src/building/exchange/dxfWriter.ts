import type { Vec2 } from '@core/model/types';
import { ansi31Hatch } from '@lib/hatch';
import { sampleArc } from '@lib/arc';
import { dimensionGeometry } from '@core/geometry/dimensionGeometry';
import { triangulatePolygon } from '@lib/triangulate';
import { DxfWriter as GenericDxfWriter } from '@lib/dxfWriter';
import type { DrawingFill, DrawingPrimitive } from '@core/model/drawing';
import { TECHNICAL_LAYERS } from '@core/geometry/technicalView';
import { DIMENSION_LAYER } from '../drawings/planModel';

/** AutoCAD Color Index per standard layer. */
// prettier-ignore
const LAYER_COLOR: Readonly<Record<string, number>> = {
  'A-WALL': 7, 'A-DOOR': 30, 'A-GLAZ': 5, 'S-GRID': 1, 'S-COLS': 8, 'S-BEAM': 4, 'S-SLAB': 9, 'A-FLOR-STRS': 6, 'A-AREA': 3,
  [DIMENSION_LAYER]: 2, [TECHNICAL_LAYERS.visible]: 7, [TECHNICAL_LAYERS.hidden]: 8, [TECHNICAL_LAYERS.center]: 1,
  [TECHNICAL_LAYERS.cut]: 7,
};

export const HIDDEN_LAYERS: ReadonlySet<string> = new Set(['S-BEAM', TECHNICAL_LAYERS.hidden]);
export const CENTER_LAYERS: ReadonlySet<string> = new Set(['S-GRID', TECHNICAL_LAYERS.center]);

/** The generic R12 writer with the AIA / technical-view layer colours. */
export class DxfWriter extends GenericDxfWriter {
  constructor() {
    super(LAYER_COLOR);
  }
}

function writeDimension(writer: DxfWriter, primitive: Extract<DrawingPrimitive, { type: 'dimension' }>): void {
  const { segments, label } = dimensionGeometry(primitive);
  for (const [a, b] of segments) writer.line(primitive.layer, a, b);
  writer.text(primitive.layer, label.at, label.height, primitive.label, 'center', label.angle);
}

/** Pattern layer of a cut layer, e.g. A-WALL → A-WALL-PATT (AIA / NCS). */
const patternLayer = (layer: string): string => `${layer}-PATT`;

/** ANSI31 (45° lines) for concrete / masonry, SOLID triangles for steel. */
function writeFill(
  writer: DxfWriter,
  layer: string,
  outer: ReadonlyArray<Vec2>,
  holes: ReadonlyArray<ReadonlyArray<Vec2>>,
  fill: DrawingFill,
  hatchSpacing: number,
): void {
  if (fill === 'hatch') {
    for (const [a, b] of ansi31Hatch([outer, ...holes], hatchSpacing)) {
      writer.line(patternLayer(layer), a, b);
    }
    return;
  }
  const { vertices, triangles } = triangulatePolygon(outer, holes);
  for (const [i, j, k] of triangles) {
    writer.solid(patternLayer(layer), vertices[i] as Vec2, vertices[j] as Vec2, vertices[k] as Vec2);
  }
}

export function writePrimitive(writer: DxfWriter, primitive: DrawingPrimitive, hatchSpacing: number): void {
  switch (primitive.type) {
    case 'polygon':
      writer.polyline(primitive.layer, primitive.points, true);
      if (primitive.fill !== undefined) {
        writeFill(writer, primitive.layer, primitive.points, primitive.holes ?? [], primitive.fill, hatchSpacing);
      }
      return;
    case 'polyline':
      writer.polyline(primitive.layer, primitive.points, false);
      return;
    case 'line':
      writer.line(primitive.layer, primitive.a, primitive.b);
      return;
    case 'arc':
      writer.arc(primitive.layer, primitive.center, primitive.radius, primitive.startAngle, primitive.endAngle);
      return;
    case 'circle':
      writer.circle(primitive.layer, primitive.center, primitive.radius);
      if (primitive.fill !== undefined) {
        const ring = sampleArc(primitive.center, primitive.radius, 0, Math.PI * 2, 32);
        writeFill(writer, primitive.layer, ring, [], primitive.fill, hatchSpacing);
      }
      return;
    case 'text':
      writer.text(primitive.layer, primitive.at, primitive.height, primitive.content, 'center');
      return;
    case 'dimension':
      writeDimension(writer, primitive);
      return;
  }
}
