/**
 * @layer ui/viewport/2d
 *
 * Pure hit-testing for window / crossing box selection (standard CAD):
 *   window   = drag left -> right: entities FULLY inside the box
 *   crossing = drag right -> left: entities inside OR touching the box
 * Geometry is sampled in world XY (entity position applied), like picking in modifyHelpers.
 */

import type { CadDocument, Entity, EntityId, Vec2 } from '@core/model/types';
import { dimensionLabelBox, TEXT_PICK_EM_WIDTH } from './modifyHelpers';
import { solidOutline } from './solidOutline';

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
export function boxFromCorners(a: Vec2, b: Vec2): Box {
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

function sampleArc(
  center: Vec2,
  radiusX: number,
  radiusY: number,
  startAngle: number,
  sweep: number,
): Vec2[] {
  return Array.from({ length: CURVE_SAMPLES + 1 }, (_, i): Vec2 => {
    const angle = startAngle + (sweep * i) / CURVE_SAMPLES;
    return [center[0] + radiusX * Math.cos(angle), center[1] + radiusY * Math.sin(angle)];
  });
}

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
      return lines(
        entity.closed ? [...entity.points, ...entity.points.slice(0, 1)] : [...entity.points],
      );
    case 'spline':
      return lines(
        entity.closed ? [...entity.points, ...entity.points.slice(0, 1)] : [...entity.points],
      );
    case 'rectangle':
      return lines([
        [0, 0],
        [entity.width, 0],
        [entity.width, entity.height],
        [0, entity.height],
        [0, 0],
      ]);
    case 'circle':
      return lines(sampleArc(entity.center, entity.radius, entity.radius, 0, 2 * Math.PI));
    case 'ellipse':
      return lines(sampleArc(entity.center, entity.radiusX, entity.radiusY, 0, 2 * Math.PI));
    case 'arc': {
      const sweep =
        (((entity.endAngle - entity.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return lines(
        sampleArc(entity.center, entity.radius, entity.radius, entity.startAngle, sweep),
      );
    }
    case 'point':
      return lines([[0, 0]]);
    case 'text': {
      const width = entity.content.length * entity.height * TEXT_PICK_EM_WIDTH;
      const left = entity.anchor === 'center' ? -width / 2 : entity.anchor === 'right' ? -width : 0;
      const [x0, y0] = world([left, -entity.height / 2]);
      return {
        polylines: [],
        boxes: [{ minX: x0, minY: y0, maxX: x0 + width, maxY: y0 + entity.height }],
      };
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
      // 3D solids: their top-view outline rings (derived 'bim' geometry is drawn elsewhere).
      if (entity.tags?.includes('bim') === true) return null;
      const rings = solidOutline(document, entity);
      return rings === null
        ? null
        : { polylines: rings.map((ring) => [...ring, ...ring.slice(0, 1)]), boxes: [] };
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
