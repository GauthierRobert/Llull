/**
 * @layer ui/viewport/2d
 *
 * Pure geometry helpers for the interactive 2D modify tools.
 *
 * All functions are deterministic and side-effect free — they compute
 * dispatch params from raw pick coordinates. Unit-tested in tests/unit/.
 *
 * @pure
 */

import { distance, pointInPolygon, polygonArea, projectOntoSegment } from '@lib/polygon';
import type * as THREE from 'three';
import type { CadDocument, DimensionEntity, Entity, EntityId, Vec2 } from '@core/model/types';
import { is3D } from '@core/model/types';
import { DEFAULT_OFFSET, dimensionDrawing } from './entities/dimensionGeometry';
import { nearestOnArc } from './snapping/geometry';
import { ringsDistSq, solidOutline } from './solidOutline';

/** Pick radius in screen pixels (selection and modify-tool picks). */
export const PICK_RADIUS_PX = 10;

interface NearestVertexResult {
  /** 0-based index of the nearest vertex. */
  vertexIndex: number;
  /** World-space position of that vertex. */
  point: Vec2;
  /** Squared distance from the pick point to the vertex. */
  distSq: number;
}

/**
 * Find the vertex on a polyline that is nearest to a pick point.
 *
 * Returns null when the points array is empty.
 *
 * @pure
 * @failure returns null when points is empty
 */
export function nearestVertex(points: ReadonlyArray<Vec2>, pick: Vec2): NearestVertexResult | null {
  if (points.length === 0) return null;

  let best: NearestVertexResult | null = null;
  points.forEach((point, vertexIndex) => {
    const dx = point[0] - pick[0];
    const dy = point[1] - pick[1];
    const distSq = dx * dx + dy * dy;
    if (best === null || distSq < best.distSq) best = { vertexIndex, point, distSq };
  });
  return best;
}

/**
 * Determine the sign of the offset distance from a pick point relative to a line.
 *
 * Positive → the pick point is to the LEFT of start→end (same as offset_2d convention).
 * Negative → to the RIGHT.
 * Zero → pick is on the line; returns +1 by default.
 *
 * @pure
 */
export function offsetSideSign(start: Vec2, end: Vec2, pick: Vec2): 1 | -1 {
  // Cross product of (end-start) × (pick-start)
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const px = pick[0] - start[0];
  const py = pick[1] - start[1];
  const cross = dx * py - dy * px;
  return cross >= 0 ? 1 : -1;
}

/**
 * `distance` signed by the side of the entity's first segment on which `worldPick` lies
 * (offset_2d convention: positive = left of start→end). Unsigned when there is no pick, no
 * entity, or the entity has no first segment.
 *
 * @pure
 */
export function signedOffsetDistance(
  entity: Entity | undefined,
  worldPick: Vec2 | null,
  distance: number,
): number {
  if (entity === undefined || worldPick === null) return distance;
  // Shift the world-space pick into the entity's local frame.
  const localPick: Vec2 = [worldPick[0] - entity.position[0], worldPick[1] - entity.position[1]];
  if (entity.kind === 'line') return distance * offsetSideSign(entity.start, entity.end, localPick);
  const [first, second] = entity.kind === 'polyline' ? entity.points : [];
  return first && second ? distance * offsetSideSign(first, second, localPick) : distance;
}

/** Squared distance from point P to the segment AB. @pure */
function pointToSegDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  return projectOntoSegment(p, a, b).distance ** 2;
}

/**
 * Minimum squared distance from a world-space pick point to a 2D entity.
 *
 * All 2D entity geometry is LOCAL to the entity's work plane; `entity.position`
 * is the work-plane origin in world space. The world-space pick is shifted into
 * the entity's local frame and all geometry is compared in that frame.
 *
 * Handles: line, polyline, circle, rectangle, point, arc (swept range only),
 * ellipse (sampled), spline (through its control points).
 * Returns Infinity for unsupported kinds.
 *
 * @pure
 */
export function entityDistSq(entity: Entity, worldPick: Vec2): number {
  // Shift pick into local frame — same for every kind.
  const ox = entity.position[0];
  const oy = entity.position[1];
  const pick: Vec2 = [worldPick[0] - ox, worldPick[1] - oy];

  switch (entity.kind) {
    case 'line':
      return pointToSegDistSq(pick, entity.start, entity.end);
    case 'polyline':
    case 'spline':
      return chainDistSq(pick, entity.points, entity.closed);
    case 'circle': {
      const dx = pick[0] - entity.center[0];
      const dy = pick[1] - entity.center[1];
      const d = Math.sqrt(dx * dx + dy * dy) - entity.radius;
      return d * d;
    }
    case 'arc': {
      // Distance to the nearest point on the swept arc (not its full circle).
      const [cx, cy] = entity.center;
      const [nx, ny] = nearestOnArc(
        pick[0],
        pick[1],
        cx,
        cy,
        entity.radius,
        entity.startAngle,
        entity.endAngle,
        false,
      );
      return distance(pick, [nx, ny]) ** 2;
    }
    case 'rectangle': {
      // Rectangle corners are in local space (lower-left at local origin).
      const { width, height } = entity;
      return chainDistSq(
        pick,
        [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
        ],
        true,
      );
    }
    case 'point':
      return distance(pick, [0, 0]) ** 2;
    case 'text': {
      // Estimated text box (no font metrics here): ~0.6 em per character, one line tall.
      const width = entity.content.length * entity.height * TEXT_PICK_EM_WIDTH;
      const left = entity.anchor === 'center' ? -width / 2 : entity.anchor === 'right' ? -width : 0;
      const dx = Math.max(left - pick[0], 0, pick[0] - (left + width));
      const dy = Math.max(Math.abs(pick[1]) - entity.height / 2, 0);
      return dx * dx + dy * dy;
    }
    case 'ellipse': {
      const { center, radiusX, radiusY } = entity;
      const samples = Array.from({ length: ELLIPSE_PICK_SAMPLES + 1 }, (_, i): Vec2 => {
        const t = (i / ELLIPSE_PICK_SAMPLES) * 2 * Math.PI;
        return [center[0] + radiusX * Math.cos(t), center[1] + radiusY * Math.sin(t)];
      });
      return chainDistSq(pick, samples, false);
    }
    default:
      return Infinity;
  }
}

/** Average glyph advance as a fraction of the text height, used to estimate a text pick box. */
export const TEXT_PICK_EM_WIDTH = 0.6;

/** Segments used to approximate an ellipse outline for picking. */
const ELLIPSE_PICK_SAMPLES = 48;

/** Minimum squared distance from `pick` to a chain of segments (optionally closed). @pure */
function chainDistSq(pick: Vec2, points: ReadonlyArray<Vec2>, closed: boolean): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a && b) best = Math.min(best, pointToSegDistSq(pick, a, b));
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (closed && points.length > 1 && first && last) {
    best = Math.min(best, pointToSegDistSq(pick, last, first));
  }
  return best;
}

/** Dimension label height (world units) used for picking — matches DimensionRenderer2D. */
const DIMENSION_LABEL_HEIGHT = 0.5;

interface LabelBox {
  /** World-space centre of the label. */
  readonly center: Vec2;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * World-space box of a dimension's label (width estimated from the label text).
 * Dimensions are associative, so the label position comes from the referenced entities.
 * @failure dangling or wrong-kind references -> null
 */
export function dimensionLabelBox(
  document: CadDocument,
  dimension: DimensionEntity,
): LabelBox | null {
  const drawing = dimensionDrawing(
    dimension.dimensionKind,
    dimension.entityIds.map((id) => document.entities[id]),
    dimension.offset ?? DEFAULT_OFFSET,
    dimension.color,
  );
  if (drawing === null) return null;
  drawing.lines?.geometry.dispose();
  (drawing.lines?.material as THREE.Material | undefined)?.dispose();
  const text =
    dimension.label ||
    (dimension.dimensionKind === 'angular'
      ? `${drawing.value.toFixed(1)}°`
      : drawing.value.toFixed(dimension.precision ?? document.displayPrecision));
  return {
    center: [dimension.position[0] + drawing.textX, dimension.position[1] + drawing.textY],
    halfWidth: (text.length * DIMENSION_LABEL_HEIGHT * TEXT_PICK_EM_WIDTH) / 2,
    halfHeight: DIMENSION_LABEL_HEIGHT / 2,
  };
}

/**
 * Squared distance from `worldPick` to a dimension's label box.
 * @failure dangling or wrong-kind references -> Infinity (not pickable)
 */
export function dimensionLabelDistSq(
  document: CadDocument,
  dimension: DimensionEntity,
  worldPick: Vec2,
): number {
  const box = dimensionLabelBox(document, dimension);
  if (box === null) return Infinity;
  const dx = Math.max(Math.abs(worldPick[0] - box.center[0]) - box.halfWidth, 0);
  const dy = Math.max(Math.abs(worldPick[1] - box.center[1]) - box.halfHeight, 0);
  return dx * dx + dy * dy;
}

/**
 * Squared distance to a 3D solid's top-view footprint outline; derived building geometry
 * (`bim` tag, drawn per level elsewhere) is not pickable here.
 */
function solidOutlineDistSq(document: CadDocument, solid: Entity, worldPick: Vec2): number {
  if (solid.tags?.includes('bim') === true) return Infinity;
  const rings = solidOutline(document, solid);
  return rings === null ? Infinity : ringsDistSq(rings, worldPick);
}

/**
 * Id of the entity nearest to `worldPick` within `tolerance` world units, or null.
 * Entities rejected by `isPickable` (e.g. hidden ones) are ignored.
 * @pure
 */
export function nearestEntityId(
  document: CadDocument,
  worldPick: Vec2,
  tolerance: number,
  isPickable: (entity: Entity) => boolean = () => true,
): EntityId | null {
  const toleranceSq = tolerance * tolerance;
  let bestId: EntityId | null = null;
  let bestDist = Infinity;
  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity || !isPickable(entity)) continue;
    const dSq =
      entity.kind === 'dimension'
        ? dimensionLabelDistSq(document, entity, worldPick)
        : is3D(entity)
          ? solidOutlineDistSq(document, entity, worldPick)
          : entityDistSq(entity, worldPick);
    if (dSq < toleranceSq && dSq < bestDist) {
      bestDist = dSq;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Enclosed area of a closed 2D entity when `worldPick` lies inside it, else null.
 * Closed kinds: rectangle, circle, ellipse, closed polyline.
 * @pure
 */
export function enclosingArea(entity: Entity, worldPick: Vec2): number | null {
  const pick: Vec2 = [worldPick[0] - entity.position[0], worldPick[1] - entity.position[1]];
  switch (entity.kind) {
    case 'rectangle': {
      const { width, height } = entity;
      const inside = pick[0] >= 0 && pick[0] <= width && pick[1] >= 0 && pick[1] <= height;
      return inside ? width * height : null;
    }
    case 'circle': {
      const inside = distance(pick, entity.center) <= entity.radius;
      return inside ? Math.PI * entity.radius * entity.radius : null;
    }
    case 'ellipse': {
      const { center, radiusX, radiusY } = entity;
      if (radiusX <= 0 || radiusY <= 0) return null;
      const u = (pick[0] - center[0]) / radiusX;
      const v = (pick[1] - center[1]) / radiusY;
      return u * u + v * v <= 1 ? Math.PI * radiusX * radiusY : null;
    }
    case 'polyline': {
      const { closed, points } = entity;
      if (!closed || points.length < 3 || !pointInPolygon(pick, points)) return null;
      return polygonArea(points);
    }
    default:
      return null;
  }
}

/**
 * Selection pick: the nearest outline within `tolerance` wins; otherwise the smallest closed
 * shape containing the point; otherwise null.
 * @pure
 */
export function pickEntityId(
  document: CadDocument,
  worldPick: Vec2,
  tolerance: number,
  isPickable: (entity: Entity) => boolean = () => true,
): EntityId | null {
  const onOutline = nearestEntityId(document, worldPick, tolerance, isPickable);
  if (onOutline !== null) return onOutline;
  let bestId: EntityId | null = null;
  let bestArea = Infinity;
  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity || !isPickable(entity)) continue;
    const area = enclosingArea(entity, worldPick);
    if (area !== null && area < bestArea) {
      bestArea = area;
      bestId = id;
    }
  }
  return bestId;
}
