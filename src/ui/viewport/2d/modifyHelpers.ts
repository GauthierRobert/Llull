// Pure pick geometry for the 2D select/modify tools. 2D entity geometry is local to its work plane; picks shift by `position`.

import { ellipsePoint } from '@lib/arc';
import { distance, pointInPolygon, projectOntoSegment } from '@lib/polygon';
import type * as THREE from 'three';
import type { CadDocument, DimensionEntity, Entity, EntityId, ImageEntity, TextEntity, Vec2 } from '@core/model/types';
import { is3D } from '@core/model/types';
import { GLYPH_WIDTH_RATIO, textLocalBounds } from '@core/geometry/bounds';
import { closedShapeArea } from '@core/geometry/shapeArea';
import { underlayCorners } from '@core/geometry/imageUnderlay';
import { dimensionText } from '@core/geometry/dimensionAnnotation';
import { DEFAULT_OFFSET, dimensionDrawing } from './entities/dimensionGeometry';
import { nearestOnArc } from './snapping/geometry';
import { currentSectionCutDepth } from './sectionCut';
import { solidSegments } from './solidDrawing';
import { segmentsDistSq } from './solidDrawingEdges';
import { rectangleCorners } from '../lineGeometry';

export const PICK_RADIUS_PX = 10;

interface NearestVertexResult {
  vertexIndex: number;
  point: Vec2;
  distSq: number;
}

/** @failure empty points -> null */
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

/** offset_2d convention: +1 when `pick` is LEFT of start→end (or on it), else -1. */
export function offsetSideSign(start: Vec2, end: Vec2, pick: Vec2): 1 | -1 {
  return (end[0] - start[0]) * (pick[1] - start[1]) - (end[1] - start[1]) * (pick[0] - start[0]) >= 0 ? 1 : -1;
}

/** `distance` signed by the side of the entity's first segment `worldPick` is on; unsigned without pick/entity/segment. */
export function signedOffsetDistance(entity: Entity | undefined, worldPick: Vec2 | null, distance: number): number {
  if (entity === undefined || worldPick === null) return distance;
  const localPick: Vec2 = [worldPick[0] - entity.position[0], worldPick[1] - entity.position[1]];
  if (entity.kind === 'line') return distance * offsetSideSign(entity.start, entity.end, localPick);
  const [first, second] = entity.kind === 'polyline' ? entity.points : [];
  return first && second ? distance * offsetSideSign(first, second, localPick) : distance;
}

function pointToSegDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  return projectOntoSegment(p, a, b).distance ** 2;
}

/** Squared pick distance to a 2D entity's outline (arc: swept range only; spline: control polygon); Infinity if unsupported. */
export function entityDistSq(entity: Entity, worldPick: Vec2): number {
  const pick: Vec2 = [worldPick[0] - entity.position[0], worldPick[1] - entity.position[1]];

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
      const [cx, cy] = entity.center;
      const [nx, ny] = nearestOnArc(pick[0], pick[1], cx, cy, entity.radius, entity.startAngle, entity.endAngle, false);
      return distance(pick, [nx, ny]) ** 2;
    }
    case 'rectangle':
      return chainDistSq(pick, rectangleCorners(entity.width, entity.height), true);
    case 'point':
      return distance(pick, [0, 0]) ** 2;
    case 'text': {
      const { left, width, height } = textLocalBox(entity);
      const dx = Math.max(left - pick[0], 0, pick[0] - (left + width));
      const dy = Math.max(Math.abs(pick[1]) - height / 2, 0);
      return dx * dx + dy * dy;
    }
    case 'ellipse': {
      const { center, radiusX, radiusY } = entity;
      const samples = Array.from(
        { length: ELLIPSE_PICK_SAMPLES + 1 },
        (_, i): Vec2 => ellipsePoint(center, radiusX, radiusY, (i / ELLIPSE_PICK_SAMPLES) * 2 * Math.PI),
      );
      return chainDistSq(pick, samples, false);
    }
    case 'image': {
      const frame = underlayFrame(entity);
      return frame === null ? Infinity : chainDistSq(worldPick, frame, true);
    }
    default:
      return Infinity;
  }
}

/** World-XY corners of an image underlay; null when locked, so it is never picked while tracing over it. */
export function underlayFrame(entity: ImageEntity): Vec2[] | null {
  if (entity.locked) return null;
  return underlayCorners(entity).map(([x, y]): Vec2 => [x, y]);
}

/** Entity-local text box from core `textLocalBounds`, centred vertically on the origin. */
export function textLocalBox(entity: TextEntity): { left: number; width: number; height: number } {
  const { min, max } = textLocalBounds(entity);
  return { left: min[0], width: max[0] - min[0], height: max[1] - min[1] };
}

const ELLIPSE_PICK_SAMPLES = 48;

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

/** Matches DimensionRenderer2D. */
const DIMENSION_LABEL_HEIGHT = 0.5;

interface LabelBox {
  readonly center: Vec2;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** World box of an (associative) dimension's label. @failure dangling or wrong-kind references -> null */
export function dimensionLabelBox(document: CadDocument, dimension: DimensionEntity): LabelBox | null {
  const drawing = dimensionDrawing(
    dimension.dimensionKind,
    dimension.entityIds.map((id) => document.entities[id]),
    dimension.offset ?? DEFAULT_OFFSET,
    dimension.color,
  );
  if (drawing === null) return null;
  drawing.lines?.geometry.dispose();
  (drawing.lines?.material as THREE.Material | undefined)?.dispose();
  const text = dimensionText(dimension, drawing.value, document.displayPrecision);
  return {
    center: [dimension.position[0] + drawing.textX, dimension.position[1] + drawing.textY],
    halfWidth: (text.length * DIMENSION_LABEL_HEIGHT * GLYPH_WIDTH_RATIO) / 2,
    halfHeight: DIMENSION_LABEL_HEIGHT / 2,
  };
}

/** @failure dangling or wrong-kind references -> Infinity (not pickable) */
export function dimensionLabelDistSq(document: CadDocument, dimension: DimensionEntity, worldPick: Vec2): number {
  const box = dimensionLabelBox(document, dimension);
  if (box === null) return Infinity;
  const dx = Math.max(Math.abs(worldPick[0] - box.center[0]) - box.halfWidth, 0);
  const dy = Math.max(Math.abs(worldPick[1] - box.center[1]) - box.halfHeight, 0);
  return dx * dx + dy * dy;
}

function solidEdgeDistSq(document: CadDocument, solid: Entity, worldPick: Vec2): number {
  return segmentsDistSq(solidSegments(document, solid, currentSectionCutDepth()), worldPick);
}

/** First pickable entity (document order) with the lowest non-null `score` below `limit`. */
function lowestScoringEntityId(
  document: CadDocument,
  isPickable: (entity: Entity) => boolean,
  score: (entity: Entity) => number | null,
  limit: number,
): EntityId | null {
  let bestId: EntityId | null = null;
  let bestScore = limit;
  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity || !isPickable(entity)) continue;
    const value = score(entity);
    if (value !== null && value < bestScore) {
      bestScore = value;
      bestId = id;
    }
  }
  return bestId;
}

export function nearestEntityId(
  document: CadDocument,
  worldPick: Vec2,
  tolerance: number,
  isPickable: (entity: Entity) => boolean = () => true,
): EntityId | null {
  return lowestScoringEntityId(
    document,
    isPickable,
    (entity) =>
      entity.kind === 'dimension'
        ? dimensionLabelDistSq(document, entity, worldPick)
        : is3D(entity)
          ? solidEdgeDistSq(document, entity, worldPick)
          : entityDistSq(entity, worldPick),
    tolerance * tolerance,
  );
}

/** Area of a closed 2D entity (rectangle/circle/ellipse/closed polyline) containing `worldPick`, else null. */
export function enclosingArea(entity: Entity, worldPick: Vec2): number | null {
  const pick: Vec2 = [worldPick[0] - entity.position[0], worldPick[1] - entity.position[1]];
  switch (entity.kind) {
    case 'rectangle':
      if (pick[0] < 0 || pick[0] > entity.width || pick[1] < 0 || pick[1] > entity.height) {
        return null;
      }
      break;
    case 'circle':
      if (distance(pick, entity.center) > entity.radius) return null;
      break;
    case 'ellipse': {
      const { center, radiusX, radiusY } = entity;
      if (radiusX <= 0 || radiusY <= 0) return null;
      const u = (pick[0] - center[0]) / radiusX;
      const v = (pick[1] - center[1]) / radiusY;
      if (u * u + v * v > 1) return null;
      break;
    }
    case 'polyline':
      if (!entity.closed || entity.points.length < 3 || !pointInPolygon(pick, entity.points)) {
        return null;
      }
      break;
    default:
      return null;
  }
  return closedShapeArea(entity);
}

/** Nearest outline within `tolerance`, else the smallest closed shape containing the point. */
export function pickEntityId(
  document: CadDocument,
  worldPick: Vec2,
  tolerance: number,
  isPickable: (entity: Entity) => boolean = () => true,
): EntityId | null {
  const onOutline = nearestEntityId(document, worldPick, tolerance, isPickable);
  if (onOutline !== null) return onOutline;
  return lowestScoringEntityId(document, isPickable, (entity) => enclosingArea(entity, worldPick), Infinity);
}
