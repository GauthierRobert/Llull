/**
 * @layer ui/viewport/2d
 *
 * Pure hit-testing for window / crossing box selection (standard CAD):
 *   window   = drag left -> right: entities FULLY inside the box
 *   crossing = drag right -> left: entities inside OR touching the box
 * Geometry is sampled in world XY (entity position applied), like picking in modifyHelpers.
 */

import type { CadDocument, Entity, EntityId, Vec2 } from '@core/model/types';
import { dimensionLabelBox, textLocalBox, underlayFrame } from './modifyHelpers';
import { solidDrawing } from './solidDrawing';
import { drawingSegments } from './solidDrawingEdges';
import { wrapAngle } from '@lib/angle';
import { closeLoop, rectangleCorners } from '../lineGeometry';
import { arcPolyline } from '@lib/arc';

export type BoxSelectMode = 'window' | 'crossing';

/** Axis-aligned world box. */
interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Sampled entity outline: open polylines plus filled boxes (text / dimension labels). */
interface SampledGeometry {
  readonly polylines: ReadonlyArray<ReadonlyArray<Vec2>>;
  readonly boxes: ReadonlyArray<Box>;
}

const CURVE_SAMPLES = 64;

/** Box spanned by two opposite corners. @pure */
function boxFromCorners(a: Vec2, b: Vec2): Box {
  return {
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1]),
  };
}

/** Left -> right = window; right -> left = crossing. @pure */
export function boxSelectMode(start: Vec2, end: Vec2): BoxSelectMode {
  return end[0] >= start[0] ? 'window' : 'crossing';
}

const insideBox = (box: Box, [x, y]: Vec2): boolean =>
  x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;

/** Liang-Barsky: does segment a->b touch the box? */
function segmentTouchesBox(box: Box, a: Vec2, b: Vec2): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a[0] - box.minX) &&
    clip(dx, box.maxX - a[0]) &&
    clip(-dy, a[1] - box.minY) &&
    clip(dy, box.maxY - a[1])
  );
}

const boxesOverlap = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

const insideOther = (inner: Box, outer: Box): boolean =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY &&
  inner.maxY <= outer.maxY;

/** Sampled world geometry of one 2D entity, or null for kinds with no selectable outline. */
function sampleEntity(document: CadDocument, entity: Entity): SampledGeometry | null {
  const [ox, oy] = entity.position;
  const world = (p: Vec2): Vec2 => [p[0] + ox, p[1] + oy];
  const lines = (...polylines: Vec2[][]): SampledGeometry => ({
    polylines: polylines.map((polyline) => polyline.map(world)),
    boxes: [],
  });
  switch (entity.kind) {
    case 'line':
      return lines([entity.start, entity.end]);
    case 'polyline':
    case 'spline':
      return lines(entity.closed ? closeLoop(entity.points) : [...entity.points]);
    case 'rectangle':
      return lines(closeLoop(rectangleCorners(entity.width, entity.height)));
    case 'circle':
      return lines(arcPolyline(entity.center, entity.radius, 0, 2 * Math.PI, CURVE_SAMPLES));
    case 'ellipse':
      return lines(
        arcPolyline(entity.center, entity.radiusX, 0, 2 * Math.PI, CURVE_SAMPLES, entity.radiusY),
      );
    case 'arc': {
      const sweep = wrapAngle(entity.endAngle - entity.startAngle);
      return lines(
        arcPolyline(entity.center, entity.radius, entity.startAngle, sweep, CURVE_SAMPLES),
      );
    }
    case 'point':
      return lines([[0, 0]]);
    case 'text': {
      const { left, width, height } = textLocalBox(entity);
      const [x0, y0] = world([left, -height / 2]);
      return {
        polylines: [],
        boxes: [{ minX: x0, minY: y0, maxX: x0 + width, maxY: y0 + height }],
      };
    }
    case 'image': {
      const frame = underlayFrame(entity);
      return frame === null ? null : { polylines: [closeLoop(frame)], boxes: [] };
    }
    case 'dimension': {
      const label = dimensionLabelBox(document, entity);
      if (label === null) return null;
      const [cx, cy] = label.center;
      return {
        polylines: [],
        boxes: [
          {
            minX: cx - label.halfWidth,
            minY: cy - label.halfHeight,
            maxX: cx + label.halfWidth,
            maxY: cy + label.halfHeight,
          },
        ],
      };
    }
    default: {
      // 3D solids: the edges of their drawn top view.
      const segments = drawingSegments(solidDrawing(document, entity));
      return segments.length === 0 ? null : { polylines: segments, boxes: [] };
    }
  }
}

/** Does the sampled geometry satisfy the selection `mode` against `box`? */
function matches(geometry: SampledGeometry, box: Box, mode: BoxSelectMode): boolean {
  const hasGeometry = geometry.polylines.length > 0 || geometry.boxes.length > 0;
  if (!hasGeometry) return false;
  if (mode === 'window') {
    return (
      geometry.polylines.every((polyline) => polyline.every((point) => insideBox(box, point))) &&
      geometry.boxes.every((other) => insideOther(other, box))
    );
  }
  return (
    geometry.boxes.some((other) => boxesOverlap(other, box)) ||
    geometry.polylines.some((polyline) =>
      polyline.some((point, index) => {
        if (insideBox(box, point)) return true;
        const next = polyline[index + 1];
        return next !== undefined && segmentTouchesBox(box, point, next);
      }),
    )
  );
}

/**
 * Ids of 2D entities selected by the box between `start` and `end`; the mode follows the drag
 * direction. Entities rejected by `isSelectable` (hidden layers etc.) are ignored.
 * @pure
 */
export function entitiesInBox(
  document: CadDocument,
  start: Vec2,
  end: Vec2,
  isSelectable: (entity: Entity) => boolean = () => true,
): EntityId[] {
  const box = boxFromCorners(start, end);
  const mode = boxSelectMode(start, end);
  return document.order.filter((id) => {
    const entity = document.entities[id];
    if (!entity || !isSelectable(entity)) return false;
    const geometry = sampleEntity(document, entity);
    return geometry !== null && matches(geometry, box, mode);
  });
}
