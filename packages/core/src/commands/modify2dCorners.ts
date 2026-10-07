import type { CadDocument, Entity, Vec2, PolylineEntity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { add2, cross2, dot2, len2, normalize2, scale2, sub2 } from '../lib/vec2';
import { resolvePolyline } from './modify2dGeometry';
import { replaceEntity, withEntity } from './entityOps';
import { newEntity } from './newEntity';
import { noop } from './noop';
import { elementAt } from '../lib/elementAt';

interface Corner {
  poly: PolylineEntity;
  vertex: Vec2;
  toPrev: Vec2;
  toNext: Vec2;
  lenPrev: number;
  lenNext: number;
}

/** `poly` with `vertexIndex` replaced by `first`, `second`, plus a new `extra` entity. */
function commitCorner(
  doc: CadDocument,
  poly: PolylineEntity,
  vertexIndex: number,
  first: Vec2,
  second: Vec2,
  extra: Entity,
): { document: CadDocument; pointCount: number } {
  const points = poly.points.flatMap((p, i): Vec2[] => (i === vertexIndex ? [first, second] : [p]));
  const updated: Entity = { ...poly, points };
  return {
    document: withEntity(replaceEntity(doc, updated), extra),
    pointCount: points.length,
  };
}

/**
 * The corner of `poly` at `vertexIndex` (vertex, vectors to its two neighbours, their lengths), or
 * the no-op result when the index is out of range or a neighbouring segment has zero length.
 * Also rejects polylines with fewer than 3 points.
 */
function resolveCorner(
  doc: CadDocument,
  command: string,
  verb: string,
  poly: PolylineEntity,
  vertexIndex: number,
): Corner | CommandResult {
  const n = poly.points.length;
  if (n < 3) {
    return noop(
      doc,
      `${command}: polyline ${poly.id} needs at least 3 points to ${verb} a corner (got ${n}).`,
    );
  }
  const isValidIndex = poly.closed
    ? vertexIndex >= 0 && vertexIndex < n
    : vertexIndex >= 1 && vertexIndex <= n - 2;
  if (!isValidIndex) {
    return noop(
      doc,
      `${command}: vertexIndex ${vertexIndex} is out of range for a ${poly.closed ? 'closed' : 'open'} polyline with ${n} points. ` +
        `Valid range: ${poly.closed ? `0..${n - 1}` : `1..${n - 2}`}.`,
    );
  }
  const prevIdx = poly.closed ? (vertexIndex - 1 + n) % n : vertexIndex - 1;
  const nextIdx = poly.closed ? (vertexIndex + 1) % n : vertexIndex + 1;
  const prev = elementAt(poly.points, prevIdx);
  const vertex = elementAt(poly.points, vertexIndex);
  const next = elementAt(poly.points, nextIdx);
  const toPrev = sub2(prev, vertex);
  const toNext = sub2(next, vertex);
  const lenPrev = len2(toPrev);
  const lenNext = len2(toNext);
  if (lenPrev < 1e-12 || lenNext < 1e-12) {
    return noop(
      doc,
      `${command}: degenerate segment at vertex ${vertexIndex} — zero-length segment.`,
    );
  }
  return { poly, vertex, toPrev, toNext, lenPrev, lenNext };
}

/**
 * @command fillet_2d
 * @pure
 * @layer core/commands
 * @affects updates 1 polyline entity (trims the two adjacent segments) + creates 1 arc entity
 * @invariant entity must be kind:'polyline'; vertexIndex must be an interior vertex (1..n-2 for open, 0..n-1 for closed)
 * @failure missing id / wrong kind / invalid vertex / radius too large -> no-op, affected:[]
 */
export const fillet2D = defineCommand({
  name: 'fillet_2d',
  description:
    'Round a single vertex of a polyline with a tangent arc of the given radius. ' +
    'The polyline entity is updated: the vertex at vertexIndex is replaced by two tangent points ' +
    '(one on each adjacent segment), and a new arc entity is added tangent to both segments. ' +
    'vertexIndex is 0-based; for an open polyline valid range is 1 to N-2 (interior vertices only); ' +
    'for a closed polyline any vertex 0 to N-1 is valid. ' +
    'No-op if radius is too large for the adjacent segment lengths, or if the entity is not a polyline.',
  params: z.object({
    id: z.string().describe('Id of the polyline entity to fillet.'),
    radius: z.number().describe('Fillet radius. Must be > 0.'),
    vertexIndex: z
      .number()
      .int()
      .describe(
        '0-based index of the polyline vertex to fillet. ' +
          'For open polylines: valid range is 1 to N-2 (interior vertices). ' +
          'For closed polylines: valid range is 0 to N-1.',
      ),
  }),
  run: (doc, { id, radius, vertexIndex }): CommandResult => {
    const found = resolvePolyline(doc, 'fillet_2d', id);
    if ('summary' in found) return found;
    if (radius <= 0) return noop(doc, `fillet_2d: radius must be > 0 (got ${radius}).`);
    const corner = resolveCorner(doc, 'fillet_2d', 'fillet', found, vertexIndex);
    if ('summary' in corner) return corner;
    const { poly, vertex, toPrev, toNext, lenPrev, lenNext } = corner;

    const dirPrev = normalize2(toPrev);
    const dirNext = normalize2(toNext);

    const cosA = Math.max(-1, Math.min(1, dot2(dirPrev, dirNext)));
    const halfAngle = Math.acos(cosA) / 2;

    if (halfAngle < 1e-9 || Math.abs(halfAngle - Math.PI / 2) < 1e-9) {
      return noop(
        doc,
        `fillet_2d: segments at vertex ${vertexIndex} are collinear — no fillet possible.`,
      );
    }

    const tanHalf = Math.tan(halfAngle);
    if (!isFinite(tanHalf) || tanHalf < 1e-12) {
      return noop(doc, `fillet_2d: degenerate angle at vertex ${vertexIndex}.`);
    }
    const tangentDist = radius / tanHalf;

    if (tangentDist > lenPrev - 1e-9 || tangentDist > lenNext - 1e-9) {
      return noop(
        doc,
        `fillet_2d: radius ${radius} is too large for the adjacent segments at vertex ${vertexIndex} ` +
          `(need tangent distance ${tangentDist.toFixed(4)}, available: prev=${lenPrev.toFixed(4)}, next=${lenNext.toFixed(4)}).`,
      );
    }

    const tangentPrev = add2(vertex, scale2(dirPrev, tangentDist));
    const tangentNext = add2(vertex, scale2(dirNext, tangentDist));
    // The arc centre lies on the bisector at radius / sin(halfAngle) from the vertex.
    const bisector = normalize2(add2(dirPrev, dirNext));
    const arcCenter = add2(vertex, scale2(bisector, radius / Math.sin(halfAngle)));
    const startAngle = Math.atan2(tangentPrev[1] - arcCenter[1], tangentPrev[0] - arcCenter[0]);
    const endAngle = Math.atan2(tangentNext[1] - arcCenter[1], tangentNext[0] - arcCenter[0]);
    // ArcEntity sweeps CCW start -> end: a left turn (cross > 0) swaps the tangent angles so the short arc is drawn.
    const leftTurn = cross2(dirPrev, dirNext) > 0;
    const arcStart = leftTurn ? endAngle : startAngle;
    const arcEnd = leftTurn ? startAngle : endAngle;

    const arcId = nextId('arc');
    const arcEntity = newEntity(
      'arc',
      arcId,
      { center: arcCenter, radius, startAngle: arcStart, endAngle: arcEnd },
      poly.position,
      poly.color,
      { rotation: poly.rotation, layerId: poly.layerId },
    );

    const { document, pointCount } = commitCorner(
      doc,
      poly,
      vertexIndex,
      tangentPrev,
      tangentNext,
      arcEntity,
    );

    return {
      document,
      summary:
        `Filleted polyline ${id} at vertex ${vertexIndex} with radius ${radius} → ` +
        `updated polyline (${pointCount} pts) + arc ${arcId}.`,
      affected: [id, arcId],
    };
  },
});

/**
 * @command chamfer_2d
 * @pure
 * @layer core/commands
 * @affects updates 1 polyline entity (trims the two adjacent segments) + creates 1 line entity (the bevel)
 * @invariant entity must be kind:'polyline'; vertexIndex must be interior vertex
 * @failure missing id / wrong kind / invalid vertex / distance too large -> no-op, affected:[]
 */
export const chamfer2D = defineCommand({
  name: 'chamfer_2d',
  description:
    'Bevel a single vertex of a polyline with a straight chamfer at the given distance. ' +
    'The polyline entity is updated: the vertex at vertexIndex is replaced by two points ' +
    'located distance back from the vertex along each adjacent segment, ' +
    'and a new line entity is added connecting those two points (the bevel face). ' +
    'vertexIndex is 0-based; for an open polyline valid range is 1 to N-2 (interior vertices only); ' +
    'for a closed polyline any vertex 0 to N-1 is valid. ' +
    'No-op if distance is too large for the adjacent segment lengths.',
  params: z.object({
    id: z.string().describe('Id of the polyline entity to chamfer.'),
    distance: z
      .number()
      .describe(
        'Chamfer setback distance from the vertex along each adjacent segment. Must be > 0.',
      ),
    vertexIndex: z
      .number()
      .int()
      .describe(
        '0-based index of the polyline vertex to chamfer. ' +
          'For open polylines: valid range is 1 to N-2. ' +
          'For closed polylines: valid range is 0 to N-1.',
      ),
  }),
  run: (doc, { id, distance, vertexIndex }): CommandResult => {
    const found = resolvePolyline(doc, 'chamfer_2d', id);
    if ('summary' in found) return found;
    if (distance <= 0) return noop(doc, `chamfer_2d: distance must be > 0 (got ${distance}).`);
    const corner = resolveCorner(doc, 'chamfer_2d', 'chamfer', found, vertexIndex);
    if ('summary' in corner) return corner;
    const { poly, vertex, toPrev, toNext, lenPrev, lenNext } = corner;

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

    const bevelPrev = add2(vertex, scale2(dirPrev, distance));
    const bevelNext = add2(vertex, scale2(dirNext, distance));

    const bevelId = nextId('line');
    const bevelLine = newEntity(
      'line',
      bevelId,
      { start: bevelPrev, end: bevelNext },
      poly.position,
      poly.color,
      { rotation: poly.rotation, layerId: poly.layerId },
    );

    const { document, pointCount } = commitCorner(
      doc,
      poly,
      vertexIndex,
      bevelPrev,
      bevelNext,
      bevelLine,
    );

    return {
      document,
      summary:
        `Chamfered polyline ${id} at vertex ${vertexIndex} with distance ${distance} → ` +
        `updated polyline (${pointCount} pts) + bevel line ${bevelId}.`,
      affected: [id, bevelId],
    };
  },
});
