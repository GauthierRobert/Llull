/**
 * Closed 2D shapes → loops in one work-plane frame, for `hatch_region`. Pure helpers over `sketchLoop`; a refusal carries the stable code
 * and the fix, never throws.
 */

import type { CurveSegment } from '../../model/curve';
import type { CadDocument, Entity, Vec2, Vec3 } from '../../model/types';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { pointInPolygon, polygonArea } from '../../lib/polygon';
import { type LoopBox, boxesTouch, contactTolerance, distanceToLoop, loopBounds, loopContact } from '../../geometry/region';
import { localBounds } from '../../geometry/bounds';
import { MAX_REGION_LOOPS } from '../limits';
import { sub3 } from '../../lib/vec3';
import { JOINT_TOLERANCE, mapSegment } from '../../geometry/curveSegments';
import { sketchLoop } from '../solids/sketchCurves';

/** Work plane the loops are expressed in: its origin and Euler rotation. */
export interface WorkPlane {
  readonly origin: Vec3;
  readonly rotation: Vec3;
}

/** One closed boundary in frame coordinates: exact chain, its polygon, the entities it came from. */
export interface FrameLoop {
  readonly ids: readonly string[];
  readonly curves: CurveSegment<Vec2>[];
  readonly profile: Vec2[];
}

export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly ids: readonly string[];
}

const refuse = (code: string, message: string, remediation: string, ids: readonly string[]): Refusal => ({
  code,
  message,
  remediation,
  ids,
});

export const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'remediation' in value;

/** Kinds that bound an area by themselves. */
const SELF_CLOSED_KINDS: ReadonlySet<string> = new Set(['circle', 'rectangle', 'ellipse']);

/** True for a shape that is a complete closed boundary on its own (circle, rectangle, ellipse, closed polyline / spline). */
export function isClosedShape(entity: Entity): boolean {
  if (SELF_CLOSED_KINDS.has(entity.kind)) return true;
  return (entity.kind === 'polyline' || entity.kind === 'spline') && entity.closed && entity.points.length >= 3;
}

/** True for a line, arc, or open polyline / spline: a piece that can only bound an area together with others. */
function isOpenPiece(entity: Entity): boolean {
  if (entity.kind === 'line' || entity.kind === 'arc') return true;
  return (entity.kind === 'polyline' || entity.kind === 'spline') && !entity.closed;
}

/** Offset of `entity` inside the plane of `frame` (in-plane x, y), or the reason it is not coplanar. */
function offsetInFrame(entity: Entity, frame: WorkPlane): Vec2 | Refusal {
  if (([0, 1, 2] as const).some((k) => Math.abs(entity.rotation[k] - frame.rotation[k]) > 1e-9))
    return refuse(
      'REGION_PLANE_MISMATCH',
      `entity "${entity.id}" is not in the work plane of the boundary (different rotation)`,
      'Hatch shapes drawn on one plane at a time (same rotation); re-draw it on the same plane or hatch each plane separately.',
      [entity.id],
    );
  const [dx, dy, dz] = inverseEulerXYZ(sub3(entity.position, frame.origin), frame.rotation);
  if (Math.abs(dz) > JOINT_TOLERANCE)
    return refuse(
      'REGION_PLANE_MISMATCH',
      `entity "${entity.id}" lies ${dz.toFixed(4)} off the work plane of the boundary`,
      'Move the entity onto the plane of the other boundary shapes (same position along the plane normal).',
      [entity.id],
    );
  return [dx, dy];
}

/** `sketchLoop` of `ids` re-expressed in `frame` (coordinates relative to the frame origin). */
function loopOf(doc: CadDocument, ids: readonly string[], frame: WorkPlane): FrameLoop | Refusal {
  const entities = ids.map((id) => doc.entities[id] as Entity);
  for (const entity of entities) {
    const offset = offsetInFrame(entity, frame);
    if (isRefusal(offset)) return offset;
  }
  const loop = sketchLoop(doc, ids);
  if (typeof loop === 'string')
    return refuse(
      'REGION_OPEN_BOUNDARY',
      `[${ids.join(', ')}] is not a closed boundary: ${loop}`,
      'Close the boundary (closed polyline, circle, rectangle, ellipse, or pieces that join end to end with no gap) and retry.',
      ids,
    );
  const [dx, dy] = offsetInFrame(entities[0] as Entity, frame) as Vec2;
  const shift = ([x, y]: Vec2): Vec2 => [x + dx, y + dy];
  return { ids, curves: loop.curves.map((segment) => mapSegment(segment, shift)), profile: loop.profile.map(shift) };
}

/**
 * The boundary loops of `ids`: every closed shape is one loop, and all open pieces together must join into one more loop.
 * @failure missing id, a kind that bounds no area, an open boundary, a different plane -> Refusal
 */
export function boundaryLoops(doc: CadDocument, ids: readonly string[], frame: WorkPlane): FrameLoop[] | Refusal {
  const loops: FrameLoop[] = [];
  const pieces: string[] = [];
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity === undefined)
      return refuse(
        'REGION_ENTITY_NOT_FOUND',
        `no entity "${id}"`,
        'Pass the ids of existing closed 2D shapes (find_entities kind=circle|rectangle|polyline).',
        [id],
      );
    if (isOpenPiece(entity)) {
      pieces.push(id);
      continue;
    }
    if (!isClosedShape(entity))
      return refuse(
        'REGION_UNSUPPORTED_KIND',
        `entity "${id}" (kind="${entity.kind}") does not bound an area`,
        'Use circle, rectangle, ellipse, closed polyline / spline, or lines / arcs that join into a closed loop.',
        [id],
      );
    const loop = loopOf(doc, [id], frame);
    if (isRefusal(loop)) return loop;
    loops.push(loop);
  }
  if (pieces.length > 0) {
    const loop = loopOf(doc, pieces, frame);
    if (isRefusal(loop)) return loop;
    loops.push(loop);
  }
  return loops;
}

/** Fraction of its size an entity box is grown by before the cheap candidate test (a spline may bulge past its control points). */
const BOX_MARGIN_RATIO = 0.1;

/** Box of `entity` in `frame` coordinates, generous enough to hold its tessellation. */
function entityFrameBox(entity: Entity, offset: Vec2): LoopBox {
  const { min, max } = localBounds(entity);
  const margin = BOX_MARGIN_RATIO * Math.max(max[0] - min[0], max[1] - min[1]) + 1e-6;
  return {
    minX: min[0] + offset[0] - margin,
    minY: min[1] + offset[1] - margin,
    maxX: max[0] + offset[0] + margin,
    maxY: max[1] + offset[1] + margin,
  };
}

/**
 * The closed shapes of the document that lie in `frame` and whose box overlaps `near` (others are skipped without being tessellated), as
 * loops in document order: the cost follows the shapes near the pick, not the document.
 * @failure more than MAX_REGION_LOOPS candidates -> REGION_TOO_LARGE
 */
function closedLoopsNear(doc: CadDocument, frame: WorkPlane, near: LoopBox): FrameLoop[] | Refusal {
  const loops: FrameLoop[] = [];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined || !isClosedShape(entity)) continue;
    const offset = offsetInFrame(entity, frame);
    if (isRefusal(offset) || !boxesTouch(entityFrameBox(entity, offset), near, 0)) continue;
    const loop = loopOf(doc, [id], frame);
    if (isRefusal(loop)) continue;
    if (loops.length >= MAX_REGION_LOOPS)
      return refuse(
        'REGION_TOO_LARGE',
        `more than ${MAX_REGION_LOOPS} closed shapes lie around the pick point`,
        'Pass the boundary shapes in ids instead of a pick point.',
        [],
      );
    loops.push(loop);
  }
  return loops;
}

/** A point strictly inside the loop's boundary side: the midpoint of its first edge, never a vertex shared with another loop. */
const probeOf = (loop: FrameLoop): Vec2 => {
  const [a, b] = [loop.profile[0] as Vec2, loop.profile[1] as Vec2];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};

const contains = (outer: FrameLoop, inner: FrameLoop): boolean => pointInPolygon(probeOf(inner), outer.profile);

const area = (loop: FrameLoop): number => polygonArea(loop.profile);

export const isCurved = (loop: FrameLoop): boolean => loop.curves.some((segment) => segment.type !== 'line');

/** Loops grouped into regions: each loop not inside another starts one, with every loop nested inside it (any depth). */
export function groupByOutermost(loops: readonly FrameLoop[]): FrameLoop[][] {
  const outers = loops.filter((loop) => !loops.some((other) => other !== loop && contains(other, loop)));
  return outers.map((outer) => [outer, ...loops.filter((loop) => loop !== outer && contains(outer, loop))]);
}

/**
 * Boundary at `point` (pick-point hatch): the smallest closed shape on the plane around the point and the shapes directly inside it as holes.
 * @failure nothing encloses the point -> REGION_POINT_NOT_ENCLOSED; the point lies on a boundary -> REGION_POINT_ON_BOUNDARY; a shape crosses
 *   or touches the chosen boundary -> REGION_LOOPS_CROSS / REGION_LOOPS_TOUCH
 */
export function loopsAtPoint(doc: CadDocument, frame: WorkPlane, point: Vec2): FrameLoop[] | Refusal {
  const candidates = closedLoopsNear(doc, frame, { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] });
  if (isRefusal(candidates)) return candidates;
  const onBoundary = candidates.find((loop) => distanceToLoop(point, loop.profile) <= contactTolerance(loop.profile, isCurved(loop)));
  if (onBoundary !== undefined)
    return refuse(
      'REGION_POINT_ON_BOUNDARY',
      `the point [${point.join(', ')}] lies on the outline of [${onBoundary.ids.join(', ')}], so the side to hatch is ambiguous`,
      'Pick a point clearly inside the area to hatch (not on an edge).',
      onBoundary.ids,
    );
  const around = candidates.filter((loop) => pointInPolygon(point, loop.profile));
  const boundary = around.reduce<FrameLoop | undefined>(
    (best, loop) => (best === undefined || area(loop) < area(best) ? loop : best),
    undefined,
  );
  if (boundary === undefined)
    return refuse(
      'REGION_POINT_NOT_ENCLOSED',
      `no closed shape encloses the point [${point.join(', ')}] on this plane`,
      'Pick a point inside a closed circle / rectangle / ellipse / closed polyline, or pass the boundary shapes in ids.',
      [],
    );
  const tolerance = contactTolerance(boundary.profile, isCurved(boundary));
  const neighbours = closedLoopsNear(doc, frame, grown(loopBounds(boundary.profile), tolerance));
  if (isRefusal(neighbours)) return neighbours;
  for (const loop of neighbours) {
    if (loop.ids[0] === boundary.ids[0]) continue;
    const contact = loopContact(boundary.profile, loop.profile, Math.max(tolerance, contactTolerance(loop.profile, isCurved(loop))));
    if (contact === null) continue;
    return refuse(
      contact === 'cross' ? 'REGION_LOOPS_CROSS' : 'REGION_LOOPS_TOUCH',
      `the boundary [${boundary.ids.join(', ')}] is ${contact === 'cross' ? 'cut by' : 'touched by'} [${loop.ids.join(', ')}]; overlapping shapes cannot be resolved from a pick point`,
      'Pass ids of the exact shapes to hatch, or trim / offset the shapes so none cross or touch.',
      [...boundary.ids, ...loop.ids],
    );
  }
  const inside = neighbours.filter((loop) => loop.ids[0] !== boundary.ids[0] && contains(boundary, loop));
  const children = inside.filter((loop) => !inside.some((other) => other !== loop && contains(other, loop)));
  return [boundary, ...children];
}

const grown = (box: LoopBox, margin: number): LoopBox => ({
  minX: box.minX - margin,
  minY: box.minY - margin,
  maxX: box.maxX + margin,
  maxY: box.maxY + margin,
});
