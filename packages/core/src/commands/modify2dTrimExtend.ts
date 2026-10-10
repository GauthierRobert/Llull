import type { CadDocument, LineEntity, Vec2 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { len2, sub2 } from '../lib/vec2';
import { segIntersect, evalLine } from './modify2dGeometry';
import { changed, noop } from './noop';
import { replaceEntity } from './entityOps';

/** `line` with its endpoint nearer to `point` moved onto `point` (a tie moves the start). */
function withNearerEndpointAt(line: LineEntity, point: Vec2): LineEntity {
  const distToStart = len2(sub2(point, line.start));
  const distToEnd = len2(sub2(point, line.end));
  return distToStart <= distToEnd ? { ...line, start: point } : { ...line, end: point };
}

/** The two distinct line entities `id` and `boundaryId`, or the no-op result explaining why not. */
function resolveLinePair(
  doc: CadDocument,
  command: string,
  id: string,
  boundaryId: string,
): { line: LineEntity; boundary: LineEntity } | CommandResult {
  if (id === boundaryId)
    return noop(doc, `${command}: id and boundaryId must be different entities.`);
  const line = doc.entities[id];
  const boundary = doc.entities[boundaryId];
  if (!line) return noop(doc, `${command}: entity ${id} not found.`);
  if (!boundary) return noop(doc, `${command}: boundary entity ${boundaryId} not found.`);
  if (line.kind !== 'line') {
    return noop(doc, `${command}: entity ${id} is kind '${line.kind}', expected 'line'.`);
  }
  if (boundary.kind !== 'line') {
    return noop(
      doc,
      `${command}: boundary ${boundaryId} is kind '${boundary.kind}', expected 'line'.`,
    );
  }
  return { line, boundary };
}

/**
 * `id` with its endpoint nearer to the intersection with `boundaryId` (infinite lines) moved onto it;
 * `trim` additionally requires the intersection to lie on both segments, `extend` does not.
 */
function moveEndpointToBoundary(
  doc: CadDocument,
  command: 'trim' | 'extend',
  id: string,
  boundaryId: string,
): CommandResult {
  const pair = resolveLinePair(doc, command, id, boundaryId);
  if ('summary' in pair) return pair;
  const { line, boundary } = pair;
  const hit = segIntersect(line.start, line.end, boundary.start, boundary.end);
  if (hit === null) {
    return noop(doc, `${command}: lines ${id} and ${boundaryId} are parallel — no intersection.`);
  }
  if (
    command === 'trim' &&
    (hit.t < -1e-9 || hit.t > 1 + 1e-9 || hit.u < -1e-9 || hit.u > 1 + 1e-9)
  ) {
    return noop(
      doc,
      `${command}: intersection of ${id} and ${boundaryId} is outside segment bounds.`,
    );
  }
  const point = evalLine(line.start, line.end, hit.t);
  const done =
    command === 'trim'
      ? `Trimmed line ${id} to intersection with ${boundaryId}`
      : `Extended line ${id} to meet ${boundaryId}`;
  return changed(
    replaceEntity(doc, withNearerEndpointAt(line, point)),
    `${done} at [${point[0].toFixed(3)}, ${point[1].toFixed(3)}].`,
    [id],
  );
}

/**
 * @command trim
 * @pure
 * @layer core/commands
 * @affects updates 1 line entity (the endpoint closer to the intersection moves to the intersection)
 * @invariant both entities must be kind:'line'
 * @failure missing id / wrong kind / no intersection -> no-op, affected:[]
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
  run: (doc, { id, boundaryId }): CommandResult =>
    moveEndpointToBoundary(doc, 'trim', id, boundaryId),
});

/**
 * @command extend
 * @pure
 * @layer core/commands
 * @affects updates 1 line entity (the endpoint closer to the boundary is extended)
 * @invariant both entities must be kind:'line'
 * @failure missing id / wrong kind / parallel lines -> no-op, affected:[]
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
  run: (doc, { id, boundaryId }): CommandResult =>
    moveEndpointToBoundary(doc, 'extend', id, boundaryId),
});
