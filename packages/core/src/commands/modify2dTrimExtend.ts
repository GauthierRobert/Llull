import type { Entity, LineEntity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import type { Vec2 } from '../model/types';
import { len2, segIntersect, evalLine } from './modify2dGeometry';

/** `line` with its endpoint nearer to `point` moved onto `point` (a tie moves the start). */
function withNearerEndpointAt(line: LineEntity, point: Vec2): LineEntity {
  const distToStart = len2([point[0] - line.start[0], point[1] - line.start[1]]);
  const distToEnd = len2([point[0] - line.end[0], point[1] - line.end[1]]);
  return distToStart <= distToEnd ? { ...line, start: point } : { ...line, end: point };
}

// ---------------------------------------------------------------------------
// trim
// ---------------------------------------------------------------------------

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
export const trim = defineCommand({
  name: 'trim',
  description:
    'Shorten a line entity so it ends exactly at its intersection with a boundary line. ' +
    'Both id and boundaryId must be line entities. ' +
    'The endpoint of id that is closer to the intersection is moved to the intersection point ' +
    '(the shorter side is trimmed; the longer side is preserved). ' +
    'No-op if either entity is not a line, they do not intersect within segment bounds, or if the entities are the same.',
  params: z.object({
    id: z.string().describe('Id of the line entity to trim.'),
    boundaryId: z.string().describe('Id of the line entity that acts as the trim boundary.'),
  }),
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

    const trimmed: Entity = withNearerEndpointAt(line, intersectionPt);

    return {
      document: {
        ...doc,
        entities: { ...doc.entities, [id]: trimmed },
      },
      summary: `Trimmed line ${id} to intersection with ${boundaryId} at [${intersectionPt[0].toFixed(3)}, ${intersectionPt[1].toFixed(3)}].`,
      affected: [id],
    };
  },
});

// ---------------------------------------------------------------------------
// extend
// ---------------------------------------------------------------------------

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
export const extend = defineCommand({
  name: 'extend',
  description:
    'Lengthen a line entity so one of its endpoints meets the infinite extension of a boundary line. ' +
    'Both id and boundaryId must be line entities. ' +
    'The endpoint of id that is closer to the intersection with the boundary (extended if necessary) ' +
    'is moved to that intersection point. ' +
    'No-op if lines are parallel, entities are missing or not lines, or id === boundaryId.',
  params: z.object({
    id: z.string().describe('Id of the line entity to extend.'),
    boundaryId: z.string().describe('Id of the line entity that acts as the extend boundary.'),
  }),
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

    const extended: Entity = withNearerEndpointAt(line, intersectionPt);

    return {
      document: {
        ...doc,
        entities: { ...doc.entities, [id]: extended },
      },
      summary: `Extended line ${id} to meet ${boundaryId} at [${intersectionPt[0].toFixed(3)}, ${intersectionPt[1].toFixed(3)}].`,
      affected: [id],
    };
  },
});
