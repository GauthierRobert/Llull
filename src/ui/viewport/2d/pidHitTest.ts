// Pure hit test of P&ID glyphs in sheet coordinates: nearest glyph whose primitives lie within a tolerance of a point.

import type { PidGlyph } from '@aec/index';
import type { DrawingPrimitive } from '@core/model/drawing';
import type { Vec2 } from '@core/model/vectors';

const ARC_SAMPLES = 16;

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distanceToPath(p: Vec2, points: readonly Vec2[], closed: boolean): number {
  let best = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    best = Math.min(best, distanceToSegment(p, points[i] as Vec2, points[(i + 1) % points.length] as Vec2));
  }
  return best;
}

function insidePolygon(p: Vec2, points: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i] as Vec2;
    const b = points[j] as Vec2;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Distance from `p` to the drawn line of `primitive`; inside a polygon / circle it is half of `interiorDistance` (an outline hit still wins). Text is not hit. */
export function distanceToPrimitive(p: Vec2, primitive: DrawingPrimitive, interiorDistance: number): number {
  switch (primitive.type) {
    case 'line':
      return distanceToSegment(p, primitive.a, primitive.b);
    case 'polyline':
      return distanceToPath(p, primitive.points, false);
    case 'polygon': {
      const edge = distanceToPath(p, primitive.points, true);
      return edge > interiorDistance && insidePolygon(p, primitive.points) ? interiorDistance * 0.5 : edge;
    }
    case 'circle': {
      const fromCentre = Math.hypot(p[0] - primitive.center[0], p[1] - primitive.center[1]);
      const radial = Math.abs(fromCentre - primitive.radius);
      return radial > interiorDistance && fromCentre < primitive.radius ? interiorDistance * 0.5 : radial;
    }
    case 'arc': {
      let sweep = primitive.endAngle - primitive.startAngle;
      while (sweep <= 0) sweep += Math.PI * 2;
      const points: Vec2[] = [];
      for (let i = 0; i <= ARC_SAMPLES; i++) {
        const angle = primitive.startAngle + (sweep * i) / ARC_SAMPLES;
        points.push([primitive.center[0] + primitive.radius * Math.cos(angle), primitive.center[1] + primitive.radius * Math.sin(angle)]);
      }
      return distanceToPath(p, points, false);
    }
    default:
      return Infinity;
  }
}

/** The glyph nearest to `point` within `tolerance` (sheet units), else null. Primitives on a hidden layer are skipped. */
export function hitTestGlyphs(
  glyphs: readonly PidGlyph[],
  point: Vec2,
  tolerance: number,
  isLayerVisible: (layer: string) => boolean = () => true,
): PidGlyph | null {
  let best: PidGlyph | null = null;
  let bestDistance = tolerance;
  for (const glyph of glyphs) {
    for (const primitive of glyph.primitives) {
      if (!isLayerVisible(primitive.layer)) continue;
      const d = distanceToPrimitive(point, primitive, tolerance);
      if (d <= bestDistance) {
        best = glyph;
        bestDistance = d;
      }
    }
  }
  return best;
}
