/**
 * 2D modify commands — edit existing 2D shapes (pure, no mutation).
 *
 * Offset convention (offset_2d):
 *   Positive distance offsets to the LEFT of the direction of travel (start→end for
 *   a line; point[i]→point[i+1] for each polyline segment). Negative is to the right.
 *   For a circle, positive distance creates a larger concentric circle; negative a smaller one.
 *   For a rectangle, positive expands all four sides outward.
 *
 * Trim convention (trim):
 *   The endpoint of `id` that is CLOSER to the intersection point is moved to that
 *   intersection (i.e. the shorter side is "trimmed off"; the longer side is kept).
 *
 * Extend convention (extend):
 *   The endpoint of `id` that is CLOSER to the boundary line (projected) is extended
 *   to meet the boundary.
 *
 * Fillet/Chamfer corner selection (fillet_2d / chamfer_2d):
 *   Single-corner mode: specify `vertexIndex` (0-based). The arc or bevel is inserted
 *   between the two segments meeting at that vertex.
 *
 * @layer core/commands
 */

import type {
  CadDocument,
  Entity,
  Vec2,
  Vec3,
  LineEntity,
  PolylineEntity,
} from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// Internal pure geometry helpers (exported for unit-testing)
// ---------------------------------------------------------------------------

/**
 * 2D cross product (scalar z-component of a × b).
 * Positive → b is CCW from a; negative → CW.
 */
export function cross2(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/** Dot product of two 2D vectors. */
export function dot2(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** Length of a 2D vector. */
export function len2(v: Vec2): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}

/** Normalize a 2D vector. Returns [0,0] if the input has zero length. */
export function normalize2(v: Vec2): Vec2 {
  const l = len2(v);
  if (l < 1e-12) return [0, 0];
  return [v[0] / l, v[1] / l];
}

/** Left-perpendicular of v (90° CCW). */
export function perp2(v: Vec2): Vec2 {
  return [-v[1], v[0]];
}

/**
 * Segment intersection — parametric.
 *
 * Returns { t, u } such that:
 *   P(t) = p + t*(q-p)   (on segment pq, valid for t ∈ [0,1])
 *   Q(u) = r + u*(s-r)   (on segment rs, valid for u ∈ [0,1])
 *
 * Returns null if lines are parallel / collinear.
 * Does NOT clamp t/u — callers decide whether [0,1] is required.
 */
export function segIntersect(
  p: Vec2,
  q: Vec2,
  r: Vec2,
  s: Vec2,
): { t: number; u: number } | null {
  const dx1 = q[0] - p[0];
  const dy1 = q[1] - p[1];
  const dx2 = s[0] - r[0];
  const dy2 = s[1] - r[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null; // parallel or collinear
  const dx3 = r[0] - p[0];
  const dy3 = r[1] - p[1];
  const t = (dx3 * dy2 - dy3 * dx2) / denom;
  const u = (dx3 * dy1 - dy3 * dx1) / denom;
  return { t, u };
}

/**
 * Compute the point on the infinite line through p→q at parameter t.
 */
export function evalLine(p: Vec2, q: Vec2, t: number): Vec2 {
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
}

/**
 * Offset a single segment (p→q) by `distance` (positive = left of travel direction).
 * Returns the two endpoints of the offset segment.
 */
export function offsetSegment(p: Vec2, q: Vec2, distance: number): [Vec2, Vec2] {
  const dir: Vec2 = [q[0] - p[0], q[1] - p[1]];
  const n = normalize2(perp2(dir));
  const dp: Vec2 = [distance * n[0], distance * n[1]];
  return [
    [p[0] + dp[0], p[1] + dp[1]],
    [q[0] + dp[0], q[1] + dp[1]],
  ];
}

/**
 * Miter-join two consecutive offset segments.
 * Given the endpoints of two consecutive offset segments [a0,a1] and [b0,b1],
 * returns the intersection of the infinite lines through them (the miter point).
 * Falls back to a[1] (simple butt join) if the lines are parallel.
 */
export function miterJoin(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): Vec2 {
  const hit = segIntersect(a0, a1, b0, b1);
  if (hit === null) return a1; // parallel — butt join
  return evalLine(a0, a1, hit.t);
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

function withoutEntity(doc: CadDocument, id: string): CadDocument {
  const entities = { ...doc.entities };
  delete entities[id];
  return {
    ...doc,
    entities,
    order: doc.order.filter((eid) => eid !== id),
    selection: doc.selection.filter((eid) => eid !== id),
  };
}

// ---------------------------------------------------------------------------
// explode_polyline
// ---------------------------------------------------------------------------

interface ExplodePolylineParams {
  id: string;
}

/**
 * @command explode_polyline
 * @pure
 * @layer core/commands
 * @affects removes 1 polyline, creates N line entities (N = number of segments)
 * @invariant source entity must be kind:'polyline' with >= 2 points
 * @failure missing id / wrong kind / < 2 points -> no-op, affected:[]
 */
export const explodePolyline: CommandDefinition<ExplodePolylineParams> = {
  name: 'explode_polyline',
  description:
    'Explode a polyline entity into individual line segments. Each consecutive pair of vertices becomes a separate line entity. ' +
    'If the polyline is closed, a final segment is added from the last point back to the first. ' +
    'The original polyline is removed. No-op if the entity is not a polyline or has fewer than 2 points.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the polyline entity to explode.',
      },
    },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return { document: doc, summary: `explode_polyline: entity ${id} not found.`, affected: [] };
    }
    if (entity.kind !== 'polyline') {
      return {
        document: doc,
        summary: `explode_polyline: entity ${id} is kind '${entity.kind}', expected 'polyline'.`,
        affected: [],
      };
    }
    const poly = entity as PolylineEntity;
    if (poly.points.length < 2) {
      return {
        document: doc,
        summary: `explode_polyline: polyline ${id} has fewer than 2 points — nothing to explode.`,
        affected: [],
      };
    }

    // Build segments
    const segments: Array<[Vec2, Vec2]> = [];
    for (let i = 0; i < poly.points.length - 1; i++) {
      segments.push([poly.points[i]!, poly.points[i + 1]!]);
    }
    if (poly.closed) {
      segments.push([poly.points[poly.points.length - 1]!, poly.points[0]!]);
    }

    // Remove the polyline, add one line per segment
    let newDoc = withoutEntity(doc, id);
    const createdIds: string[] = [];
    for (const [a, b] of segments) {
      const lineId = nextId('line');
      createdIds.push(lineId);
      const line: Entity = {
        id: lineId,
        kind: 'line',
        start: a,
        end: b,
        position: poly.position,
        rotation: poly.rotation,
        layerId: poly.layerId,
        color: poly.color,
      };
      newDoc = withEntity(newDoc, line);
    }

    return {
      document: newDoc,
      summary: `Exploded polyline ${id} into ${createdIds.length} line(s): [${createdIds.join(', ')}].`,
      affected: createdIds,
    };
  },
};

// ---------------------------------------------------------------------------
// offset_2d
// ---------------------------------------------------------------------------

interface Offset2DParams {
  id: string;
  distance: number;
}

/**
 * @command offset_2d
 * @pure
 * @layer core/commands
 * @affects creates 1 new entity (parallel copy of the source)
 * @invariant source entity must be kind:'line'|'polyline'|'circle'|'rectangle'
 * @failure missing id / unsupported kind / zero distance -> no-op, affected:[]
 *
 * Offset convention:
 *   Line/polyline: positive distance → offset to the LEFT of the direction of travel
 *   (start→end for a line; point[i]→point[i+1] for polyline segments).
 *   Circle: positive → larger concentric circle; negative → smaller (clamped to radius > 0).
 *   Rectangle: positive → expands all sides outward; negative → shrinks (clamped so each side > 0).
 */
export const offset2D: CommandDefinition<Offset2DParams> = {
  name: 'offset_2d',
  description:
    'Create a parallel-offset copy of a 2D shape at the given distance. ' +
    'Supported kinds: line (offset perpendicular to direction, positive=left of start→end), ' +
    'polyline (each segment offset then joined at miter intersections), ' +
    'circle (concentric: positive=larger, negative=smaller), ' +
    'rectangle (all sides expand/shrink: positive=outward, negative=inward). ' +
    'The original entity is unchanged; a new entity is added. ' +
    'No-op for unsupported kinds or if the resulting shape would be degenerate (e.g. negative circle radius).',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the source entity to offset.',
      },
      distance: {
        type: 'number',
        description:
          'Offset distance in work-plane units. Positive = left of direction (line/polyline) or outward (circle/rectangle). Negative reverses the direction.',
      },
    },
    required: ['id', 'distance'],
  },
  run: (doc, { id, distance }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return { document: doc, summary: `offset_2d: entity ${id} not found.`, affected: [] };
    }
    if (distance === 0) {
      return {
        document: doc,
        summary: `offset_2d: distance is 0 — no-op.`,
        affected: [],
      };
    }

    const newId = nextId('offset');
    const base = {
      position: entity.position,
      rotation: entity.rotation,
      layerId: entity.layerId,
      color: entity.color,
    };

    if (entity.kind === 'line') {
      const line = entity as LineEntity;
      const [oa, ob] = offsetSegment(line.start, line.end, distance);
      const newEntity: Entity = {
        ...base,
        id: newId,
        kind: 'line',
        start: oa,
        end: ob,
      };
      return {
        document: withEntity(doc, newEntity),
        summary: `Offset line ${id} by ${distance} → new line ${newId}.`,
        affected: [newId],
      };
    }

    if (entity.kind === 'polyline') {
      const poly = entity as PolylineEntity;
      if (poly.points.length < 2) {
        return {
          document: doc,
          summary: `offset_2d: polyline ${id} has fewer than 2 points — no-op.`,
          affected: [],
        };
      }

      // Offset each segment
      const offsetSegs: Array<[Vec2, Vec2]> = [];
      for (let i = 0; i < poly.points.length - 1; i++) {
        offsetSegs.push(offsetSegment(poly.points[i]!, poly.points[i + 1]!, distance));
      }
      if (poly.closed) {
        offsetSegs.push(
          offsetSegment(poly.points[poly.points.length - 1]!, poly.points[0]!, distance),
        );
      }

      // Compute miter join points
      const newPoints: Vec2[] = [];
      if (!poly.closed) {
        // First point: just the start of the first offset segment
        newPoints.push(offsetSegs[0]![0]);
        // Interior vertices: miter between adjacent segments
        for (let i = 0; i < offsetSegs.length - 1; i++) {
          const [a0, a1] = offsetSegs[i]!;
          const [b0, b1] = offsetSegs[i + 1]!;
          newPoints.push(miterJoin(a0, a1, b0, b1));
        }
        // Last point: end of the last offset segment
        newPoints.push(offsetSegs[offsetSegs.length - 1]![1]);
      } else {
        // For closed: every vertex is a miter join between the two adjacent segments
        const n = offsetSegs.length;
        for (let i = 0; i < n; i++) {
          const prev = offsetSegs[(i - 1 + n) % n]!;
          const curr = offsetSegs[i]!;
          newPoints.push(miterJoin(prev[0], prev[1], curr[0], curr[1]));
        }
      }

      const newEntity: Entity = {
        ...base,
        id: newId,
        kind: 'polyline',
        points: newPoints as ReadonlyArray<Vec2>,
        closed: poly.closed,
      };
      return {
        document: withEntity(doc, newEntity),
        summary: `Offset polyline ${id} by ${distance} → new polyline ${newId} (${newPoints.length} points).`,
        affected: [newId],
      };
    }

    if (entity.kind === 'circle') {
      const circle = entity as { kind: 'circle'; center: Vec2; radius: number } & typeof base & {
        id: string;
      };
      const newRadius = circle.radius + distance;
      if (newRadius <= 0) {
        return {
          document: doc,
          summary: `offset_2d: resulting circle radius ${newRadius} <= 0 — no-op.`,
          affected: [],
        };
      }
      const newEntity: Entity = {
        ...base,
        id: newId,
        kind: 'circle',
        center: circle.center,
        radius: newRadius,
      };
      return {
        document: withEntity(doc, newEntity),
        summary: `Offset circle ${id} by ${distance} → new circle ${newId} radius ${newRadius}.`,
        affected: [newId],
      };
    }

    if (entity.kind === 'rectangle') {
      const rect = entity as { kind: 'rectangle'; width: number; height: number } & typeof base & {
        id: string;
      };
      const newWidth = rect.width + 2 * distance;
      const newHeight = rect.height + 2 * distance;
      if (newWidth <= 0 || newHeight <= 0) {
        return {
          document: doc,
          summary: `offset_2d: resulting rectangle ${newWidth}×${newHeight} is degenerate — no-op.`,
          affected: [],
        };
      }
      // The offset rectangle is centered on the same position but shifted by -distance on each side.
      // We shift the origin by -distance on X and Y (lower-left moves left/down for positive offset).
      const origPos = entity.position;
      const newPos: Vec3 = [origPos[0] - distance, origPos[1] - distance, origPos[2]];
      const newEntity: Entity = {
        ...base,
        id: newId,
        kind: 'rectangle',
        width: newWidth,
        height: newHeight,
        position: newPos,
      };
      return {
        document: withEntity(doc, newEntity),
        summary: `Offset rectangle ${id} by ${distance} → new rectangle ${newId} ${newWidth}×${newHeight}.`,
        affected: [newId],
      };
    }

    return {
      document: doc,
      summary: `offset_2d: entity ${id} has unsupported kind '${entity.kind}'. Supported: line, polyline, circle, rectangle.`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// trim
// ---------------------------------------------------------------------------

interface TrimParams {
  id: string;
  boundaryId: string;
}

/**
 * @command trim
 * @pure
 * @layer core/commands
 * @affects updates 1 line entity (the endpoint closer to the intersection moves to the intersection)
 * @invariant both entities must be kind:'line'
 * @failure missing id / wrong kind / no intersection -> no-op, affected:[]
 *
 * Trim convention:
 *   The endpoint of `id` that is closer to the intersection point is moved to the
 *   intersection. The farther endpoint (and the longer portion of the line) is kept.
 *   In other words, the "short" side of the line is trimmed off.
 *   Only trims at intersections within the segment bounds (t ∈ [0,1]).
 */
export const trim: CommandDefinition<TrimParams> = {
  name: 'trim',
  description:
    'Shorten a line entity so it ends exactly at its intersection with a boundary line. ' +
    'Both id and boundaryId must be line entities. ' +
    'The endpoint of id that is closer to the intersection is moved to the intersection point ' +
    '(the shorter side is trimmed; the longer side is preserved). ' +
    'No-op if either entity is not a line, they do not intersect within segment bounds, or if the entities are the same.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the line entity to trim.',
      },
      boundaryId: {
        type: 'string',
        description: 'Id of the line entity that acts as the trim boundary.',
      },
    },
    required: ['id', 'boundaryId'],
  },
  run: (doc, { id, boundaryId }): CommandResult => {
    if (id === boundaryId) {
      return {
        document: doc,
        summary: `trim: id and boundaryId must be different entities.`,
        affected: [],
      };
    }
    const entity = doc.entities[id];
    const boundary = doc.entities[boundaryId];
    if (!entity) {
      return { document: doc, summary: `trim: entity ${id} not found.`, affected: [] };
    }
    if (!boundary) {
      return {
        document: doc,
        summary: `trim: boundary entity ${boundaryId} not found.`,
        affected: [],
      };
    }
    if (entity.kind !== 'line') {
      return {
        document: doc,
        summary: `trim: entity ${id} is kind '${entity.kind}', expected 'line'.`,
        affected: [],
      };
    }
    if (boundary.kind !== 'line') {
      return {
        document: doc,
        summary: `trim: boundary ${boundaryId} is kind '${boundary.kind}', expected 'line'.`,
        affected: [],
      };
    }

    const line = entity as LineEntity;
    const bLine = boundary as LineEntity;
    const hit = segIntersect(line.start, line.end, bLine.start, bLine.end);

    if (hit === null) {
      return {
        document: doc,
        summary: `trim: lines ${id} and ${boundaryId} are parallel — no intersection.`,
        affected: [],
      };
    }

    // The intersection must lie on the boundary segment (u ∈ [0,1])
    // and within the line segment (t ∈ [0,1])
    if (hit.t < -1e-9 || hit.t > 1 + 1e-9 || hit.u < -1e-9 || hit.u > 1 + 1e-9) {
      return {
        document: doc,
        summary: `trim: intersection of ${id} and ${boundaryId} is outside segment bounds.`,
        affected: [],
      };
    }

    const intersectionPt = evalLine(line.start, line.end, hit.t);

    // Determine which endpoint is closer to the intersection
    const distToStart = len2([
      intersectionPt[0] - line.start[0],
      intersectionPt[1] - line.start[1],
    ]);
    const distToEnd = len2([intersectionPt[0] - line.end[0], intersectionPt[1] - line.end[1]]);

    // The closer endpoint moves to the intersection (trim that side)
    let newStart = line.start;
    let newEnd = line.end;
    if (distToStart <= distToEnd) {
      newStart = intersectionPt;
    } else {
      newEnd = intersectionPt;
    }

    const trimmed: Entity = {
      ...line,
      start: newStart,
      end: newEnd,
    };

    return {
      document: {
        ...doc,
        entities: { ...doc.entities, [id]: trimmed },
      },
      summary: `Trimmed line ${id} to intersection with ${boundaryId} at [${intersectionPt[0].toFixed(3)}, ${intersectionPt[1].toFixed(3)}].`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// extend
// ---------------------------------------------------------------------------

interface ExtendParams {
  id: string;
  boundaryId: string;
}

/**
 * @command extend
 * @pure
 * @layer core/commands
 * @affects updates 1 line entity (the endpoint closer to the boundary is extended)
 * @invariant both entities must be kind:'line'
 * @failure missing id / wrong kind / parallel lines -> no-op, affected:[]
 *
 * Extend convention:
 *   Finds the intersection of the infinite line through `id` and the infinite line
 *   through `boundaryId`. The endpoint of `id` that is closer to the intersection
 *   is extended to meet it. No-op if lines are parallel.
 */
export const extend: CommandDefinition<ExtendParams> = {
  name: 'extend',
  description:
    'Lengthen a line entity so one of its endpoints meets the infinite extension of a boundary line. ' +
    'Both id and boundaryId must be line entities. ' +
    'The endpoint of id that is closer to the intersection with the boundary (extended if necessary) ' +
    'is moved to that intersection point. ' +
    'No-op if lines are parallel, entities are missing or not lines, or id === boundaryId.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the line entity to extend.',
      },
      boundaryId: {
        type: 'string',
        description: 'Id of the line entity that acts as the extend boundary.',
      },
    },
    required: ['id', 'boundaryId'],
  },
  run: (doc, { id, boundaryId }): CommandResult => {
    if (id === boundaryId) {
      return {
        document: doc,
        summary: `extend: id and boundaryId must be different entities.`,
        affected: [],
      };
    }
    const entity = doc.entities[id];
    const boundary = doc.entities[boundaryId];
    if (!entity) {
      return { document: doc, summary: `extend: entity ${id} not found.`, affected: [] };
    }
    if (!boundary) {
      return {
        document: doc,
        summary: `extend: boundary entity ${boundaryId} not found.`,
        affected: [],
      };
    }
    if (entity.kind !== 'line') {
      return {
        document: doc,
        summary: `extend: entity ${id} is kind '${entity.kind}', expected 'line'.`,
        affected: [],
      };
    }
    if (boundary.kind !== 'line') {
      return {
        document: doc,
        summary: `extend: boundary ${boundaryId} is kind '${boundary.kind}', expected 'line'.`,
        affected: [],
      };
    }

    const line = entity as LineEntity;
    const bLine = boundary as LineEntity;

    // Use infinite-line intersection (no segment clamping)
    const hit = segIntersect(line.start, line.end, bLine.start, bLine.end);
    if (hit === null) {
      return {
        document: doc,
        summary: `extend: lines ${id} and ${boundaryId} are parallel — no intersection.`,
        affected: [],
      };
    }

    const intersectionPt = evalLine(line.start, line.end, hit.t);

    // Determine which endpoint is closer to the intersection
    const distToStart = len2([
      intersectionPt[0] - line.start[0],
      intersectionPt[1] - line.start[1],
    ]);
    const distToEnd = len2([intersectionPt[0] - line.end[0], intersectionPt[1] - line.end[1]]);

    let newStart = line.start;
    let newEnd = line.end;
    if (distToStart <= distToEnd) {
      newStart = intersectionPt;
    } else {
      newEnd = intersectionPt;
    }

    const extended: Entity = {
      ...line,
      start: newStart,
      end: newEnd,
    };

    return {
      document: {
        ...doc,
        entities: { ...doc.entities, [id]: extended },
      },
      summary: `Extended line ${id} to meet ${boundaryId} at [${intersectionPt[0].toFixed(3)}, ${intersectionPt[1].toFixed(3)}].`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// fillet_2d
// ---------------------------------------------------------------------------

interface Fillet2DParams {
  id: string;
  radius: number;
  vertexIndex: number;
}

/**
 * @command fillet_2d
 * @pure
 * @layer core/commands
 * @affects updates 1 polyline entity (trims the two adjacent segments) + creates 1 arc entity
 * @invariant entity must be kind:'polyline'; vertexIndex must be an interior vertex (1..n-2 for open, 0..n-1 for closed)
 * @failure missing id / wrong kind / invalid vertex / radius too large -> no-op, affected:[]
 *
 * Single-corner mode: supply vertexIndex (0-based) to specify which vertex to fillet.
 * The arc is tangent to both adjacent segments at points located `radius` distance back
 * from the vertex along each segment. The two segment endpoints adjacent to the vertex
 * are trimmed to these tangent points; the arc is inserted as a separate ArcEntity.
 * The polyline is updated with the new trimmed points (vertex replaced by the two tangent points).
 */
export const fillet2D: CommandDefinition<Fillet2DParams> = {
  name: 'fillet_2d',
  description:
    'Round a single vertex of a polyline with a tangent arc of the given radius. ' +
    'The polyline entity is updated: the vertex at vertexIndex is replaced by two tangent points ' +
    '(one on each adjacent segment), and a new arc entity is added tangent to both segments. ' +
    'vertexIndex is 0-based; for an open polyline valid range is 1 to N-2 (interior vertices only); ' +
    'for a closed polyline any vertex 0 to N-1 is valid. ' +
    'No-op if radius is too large for the adjacent segment lengths, or if the entity is not a polyline.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the polyline entity to fillet.',
      },
      radius: {
        type: 'number',
        description: 'Fillet radius. Must be > 0.',
      },
      vertexIndex: {
        type: 'number',
        description:
          '0-based index of the polyline vertex to fillet. ' +
          'For open polylines: valid range is 1 to N-2 (interior vertices). ' +
          'For closed polylines: valid range is 0 to N-1.',
      },
    },
    required: ['id', 'radius', 'vertexIndex'],
  },
  run: (doc, { id, radius, vertexIndex }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return { document: doc, summary: `fillet_2d: entity ${id} not found.`, affected: [] };
    }
    if (entity.kind !== 'polyline') {
      return {
        document: doc,
        summary: `fillet_2d: entity ${id} is kind '${entity.kind}', expected 'polyline'.`,
        affected: [],
      };
    }
    if (radius <= 0) {
      return {
        document: doc,
        summary: `fillet_2d: radius must be > 0 (got ${radius}).`,
        affected: [],
      };
    }

    const poly = entity as PolylineEntity;
    const n = poly.points.length;

    if (n < 3) {
      return {
        document: doc,
        summary: `fillet_2d: polyline ${id} needs at least 3 points to fillet a corner (got ${n}).`,
        affected: [],
      };
    }

    // Validate vertexIndex
    const isValidIndex = poly.closed
      ? vertexIndex >= 0 && vertexIndex < n
      : vertexIndex >= 1 && vertexIndex <= n - 2;

    if (!isValidIndex) {
      return {
        document: doc,
        summary:
          `fillet_2d: vertexIndex ${vertexIndex} is out of range for a ${poly.closed ? 'closed' : 'open'} polyline with ${n} points. ` +
          `Valid range: ${poly.closed ? `0..${n - 1}` : `1..${n - 2}`}.`,
        affected: [],
      };
    }

    // Get the three points: prev, vertex, next
    const prevIdx = poly.closed ? (vertexIndex - 1 + n) % n : vertexIndex - 1;
    const nextIdx = poly.closed ? (vertexIndex + 1) % n : vertexIndex + 1;

    const prev = poly.points[prevIdx]!;
    const vertex = poly.points[vertexIndex]!;
    const next = poly.points[nextIdx]!;

    // Direction vectors from vertex to prev and next
    const toPrev: Vec2 = [prev[0] - vertex[0], prev[1] - vertex[1]];
    const toNext: Vec2 = [next[0] - vertex[0], next[1] - vertex[1]];
    const lenPrev = len2(toPrev);
    const lenNext = len2(toNext);

    if (lenPrev < 1e-12 || lenNext < 1e-12) {
      return {
        document: doc,
        summary: `fillet_2d: degenerate segment at vertex ${vertexIndex} — zero-length segment.`,
        affected: [],
      };
    }

    const dirPrev = normalize2(toPrev);
    const dirNext = normalize2(toNext);

    // Half-angle between the two segments
    // cos(theta) = dot(dirPrev, dirNext)
    const cosA = Math.max(-1, Math.min(1, dot2(dirPrev, dirNext)));
    const halfAngle = Math.acos(cosA) / 2;

    if (halfAngle < 1e-9 || Math.abs(halfAngle - Math.PI / 2) < 1e-9) {
      // Lines are collinear or form a 180° angle — no fillet needed / not possible
      return {
        document: doc,
        summary: `fillet_2d: segments at vertex ${vertexIndex} are collinear — no fillet possible.`,
        affected: [],
      };
    }

    // Distance from vertex to tangent points = radius / tan(halfAngle)
    const tanHalf = Math.tan(halfAngle);
    if (!isFinite(tanHalf) || tanHalf < 1e-12) {
      return {
        document: doc,
        summary: `fillet_2d: degenerate angle at vertex ${vertexIndex}.`,
        affected: [],
      };
    }
    const tangentDist = radius / tanHalf;

    // Check that tangent points don't exceed segment lengths
    if (tangentDist > lenPrev - 1e-9 || tangentDist > lenNext - 1e-9) {
      return {
        document: doc,
        summary:
          `fillet_2d: radius ${radius} is too large for the adjacent segments at vertex ${vertexIndex} ` +
          `(need tangent distance ${tangentDist.toFixed(4)}, available: prev=${lenPrev.toFixed(4)}, next=${lenNext.toFixed(4)}).`,
        affected: [],
      };
    }

    // Tangent points on each adjacent segment
    const tangentPrev: Vec2 = [
      vertex[0] + dirPrev[0] * tangentDist,
      vertex[1] + dirPrev[1] * tangentDist,
    ];
    const tangentNext: Vec2 = [
      vertex[0] + dirNext[0] * tangentDist,
      vertex[1] + dirNext[1] * tangentDist,
    ];

    // Arc center: located perpendicular to each tangent, distance `radius` from each tangent point
    // The center is along the bisector from vertex at distance radius / sin(halfAngle)
    const bisector = normalize2([dirPrev[0] + dirNext[0], dirPrev[1] + dirNext[1]]);
    const centerDist = radius / Math.sin(halfAngle);
    const arcCenter: Vec2 = [
      vertex[0] + bisector[0] * centerDist,
      vertex[1] + bisector[1] * centerDist,
    ];

    // Compute start and end angles of the fillet arc
    const startAngle = Math.atan2(tangentPrev[1] - arcCenter[1], tangentPrev[0] - arcCenter[0]);
    const endAngle = Math.atan2(tangentNext[1] - arcCenter[1], tangentNext[0] - arcCenter[0]);

    // Determine arc sweep direction: the arc should curve around the vertex.
    // The cross product of dirPrev × dirNext determines which side the center is on.
    const crossVal = cross2(dirPrev, dirNext);

    // For CCW arcs, endAngle should be CCW from startAngle.
    // If crossVal > 0, the turn is to the left (CCW) and we want a CW arc to fill the corner.
    // Adjust angles so the arc sweeps through the fillet region.
    let arcStart = startAngle;
    let arcEnd = endAngle;

    // If the center is on the same side as the vertex interior (cross > 0 means left turn),
    // the arc sweeps CW from tangentPrev to tangentNext.
    // Our ArcEntity convention: CCW from startAngle to endAngle.
    // For a right-turn (cross < 0): arc sweeps CCW naturally.
    // For a left-turn (cross > 0): swap and make it CCW (which goes the long way around → need the short CW).
    // Simplest approach: just store start/end; the renderer draws CCW.
    // We'll normalize: ensure the arc sweeps through the fillet (short arc).
    if (crossVal > 0) {
      // Left turn: center is to the right of our direction, so swap to get CCW short arc
      arcStart = endAngle;
      arcEnd = startAngle;
    }

    // Build updated polyline points, inserting the two tangent points in place of the vertex
    const newPoints: Vec2[] = [];
    if (!poly.closed) {
      for (let i = 0; i < n; i++) {
        if (i === vertexIndex) {
          newPoints.push(tangentPrev);
          newPoints.push(tangentNext);
        } else {
          newPoints.push(poly.points[i]!);
        }
      }
    } else {
      // Closed: replace the vertex at vertexIndex with tangentPrev, tangentNext
      // (order matters: prev then next, so the polyline still connects correctly)
      for (let i = 0; i < n; i++) {
        if (i === vertexIndex) {
          newPoints.push(tangentPrev);
          newPoints.push(tangentNext);
        } else {
          newPoints.push(poly.points[i]!);
        }
      }
    }

    // Create arc entity
    const arcId = nextId('arc');
    const arcEntity: Entity = {
      id: arcId,
      kind: 'arc',
      center: arcCenter,
      radius,
      startAngle: arcStart,
      endAngle: arcEnd,
      position: poly.position,
      rotation: poly.rotation,
      layerId: poly.layerId,
      color: poly.color,
    };

    // Update polyline
    const updatedPoly: Entity = {
      ...poly,
      points: newPoints as ReadonlyArray<Vec2>,
    };

    const newDoc = withEntity(
      {
        ...doc,
        entities: { ...doc.entities, [id]: updatedPoly },
      },
      arcEntity,
    );

    return {
      document: newDoc,
      summary:
        `Filleted polyline ${id} at vertex ${vertexIndex} with radius ${radius} → ` +
        `updated polyline (${newPoints.length} pts) + arc ${arcId}.`,
      affected: [id, arcId],
    };
  },
};

// ---------------------------------------------------------------------------
// chamfer_2d
// ---------------------------------------------------------------------------

interface Chamfer2DParams {
  id: string;
  distance: number;
  vertexIndex: number;
}

/**
 * @command chamfer_2d
 * @pure
 * @layer core/commands
 * @affects updates 1 polyline entity (trims the two adjacent segments) + creates 1 line entity (the bevel)
 * @invariant entity must be kind:'polyline'; vertexIndex must be interior vertex
 * @failure missing id / wrong kind / invalid vertex / distance too large -> no-op, affected:[]
 *
 * Single-corner mode: supply vertexIndex (0-based) to specify which vertex to chamfer.
 * The bevel is a straight line connecting the two points located `distance` back from the
 * vertex along each adjacent segment. The polyline is updated with the bevel endpoints
 * (vertex replaced by the two trim points); the bevel is inserted as a separate LineEntity.
 */
export const chamfer2D: CommandDefinition<Chamfer2DParams> = {
  name: 'chamfer_2d',
  description:
    'Bevel a single vertex of a polyline with a straight chamfer at the given distance. ' +
    'The polyline entity is updated: the vertex at vertexIndex is replaced by two points ' +
    'located distance back from the vertex along each adjacent segment, ' +
    'and a new line entity is added connecting those two points (the bevel face). ' +
    'vertexIndex is 0-based; for an open polyline valid range is 1 to N-2 (interior vertices only); ' +
    'for a closed polyline any vertex 0 to N-1 is valid. ' +
    'No-op if distance is too large for the adjacent segment lengths.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the polyline entity to chamfer.',
      },
      distance: {
        type: 'number',
        description:
          'Chamfer setback distance from the vertex along each adjacent segment. Must be > 0.',
      },
      vertexIndex: {
        type: 'number',
        description:
          '0-based index of the polyline vertex to chamfer. ' +
          'For open polylines: valid range is 1 to N-2. ' +
          'For closed polylines: valid range is 0 to N-1.',
      },
    },
    required: ['id', 'distance', 'vertexIndex'],
  },
  run: (doc, { id, distance, vertexIndex }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return { document: doc, summary: `chamfer_2d: entity ${id} not found.`, affected: [] };
    }
    if (entity.kind !== 'polyline') {
      return {
        document: doc,
        summary: `chamfer_2d: entity ${id} is kind '${entity.kind}', expected 'polyline'.`,
        affected: [],
      };
    }
    if (distance <= 0) {
      return {
        document: doc,
        summary: `chamfer_2d: distance must be > 0 (got ${distance}).`,
        affected: [],
      };
    }

    const poly = entity as PolylineEntity;
    const n = poly.points.length;

    if (n < 3) {
      return {
        document: doc,
        summary: `chamfer_2d: polyline ${id} needs at least 3 points to chamfer a corner (got ${n}).`,
        affected: [],
      };
    }

    const isValidIndex = poly.closed
      ? vertexIndex >= 0 && vertexIndex < n
      : vertexIndex >= 1 && vertexIndex <= n - 2;

    if (!isValidIndex) {
      return {
        document: doc,
        summary:
          `chamfer_2d: vertexIndex ${vertexIndex} is out of range for a ${poly.closed ? 'closed' : 'open'} polyline with ${n} points. ` +
          `Valid range: ${poly.closed ? `0..${n - 1}` : `1..${n - 2}`}.`,
        affected: [],
      };
    }

    const prevIdx = poly.closed ? (vertexIndex - 1 + n) % n : vertexIndex - 1;
    const nextIdx = poly.closed ? (vertexIndex + 1) % n : vertexIndex + 1;

    const prev = poly.points[prevIdx]!;
    const vertex = poly.points[vertexIndex]!;
    const next = poly.points[nextIdx]!;

    const toPrev: Vec2 = [prev[0] - vertex[0], prev[1] - vertex[1]];
    const toNext: Vec2 = [next[0] - vertex[0], next[1] - vertex[1]];
    const lenPrev = len2(toPrev);
    const lenNext = len2(toNext);

    if (lenPrev < 1e-12 || lenNext < 1e-12) {
      return {
        document: doc,
        summary: `chamfer_2d: degenerate segment at vertex ${vertexIndex} — zero-length segment.`,
        affected: [],
      };
    }

    if (distance > lenPrev - 1e-9 || distance > lenNext - 1e-9) {
      return {
        document: doc,
        summary:
          `chamfer_2d: distance ${distance} is too large for the adjacent segments at vertex ${vertexIndex} ` +
          `(prev segment length=${lenPrev.toFixed(4)}, next segment length=${lenNext.toFixed(4)}).`,
        affected: [],
      };
    }

    const dirPrev = normalize2(toPrev);
    const dirNext = normalize2(toNext);

    const bevelPrev: Vec2 = [
      vertex[0] + dirPrev[0] * distance,
      vertex[1] + dirPrev[1] * distance,
    ];
    const bevelNext: Vec2 = [
      vertex[0] + dirNext[0] * distance,
      vertex[1] + dirNext[1] * distance,
    ];

    // Build updated polyline
    const newPoints: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      if (i === vertexIndex) {
        newPoints.push(bevelPrev);
        newPoints.push(bevelNext);
      } else {
        newPoints.push(poly.points[i]!);
      }
    }

    // Create bevel line entity
    const bevelId = nextId('line');
    const bevelLine: Entity = {
      id: bevelId,
      kind: 'line',
      start: bevelPrev,
      end: bevelNext,
      position: poly.position,
      rotation: poly.rotation,
      layerId: poly.layerId,
      color: poly.color,
    };

    const updatedPoly: Entity = {
      ...poly,
      points: newPoints as ReadonlyArray<Vec2>,
    };

    const newDoc = withEntity(
      {
        ...doc,
        entities: { ...doc.entities, [id]: updatedPoly },
      },
      bevelLine,
    );

    return {
      document: newDoc,
      summary:
        `Chamfered polyline ${id} at vertex ${vertexIndex} with distance ${distance} → ` +
        `updated polyline (${newPoints.length} pts) + bevel line ${bevelId}.`,
      affected: [id, bevelId],
    };
  },
};
