import type { CadDocument, Entity, Vec2, PolylineEntity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { cross2, dot2, len2, normalize2 } from './modify2dGeometry';
import { withEntity } from './entityOps';
import { noOp } from './commandResult';

type CornerResolution =
  | {
      ok: true;
      vertex: Vec2;
      toPrev: Vec2;
      toNext: Vec2;
      lenPrev: number;
      lenNext: number;
    }
  | { ok: false; result: CommandResult };

/**
 * The corner of `poly` at `vertexIndex` (vertex, vectors to its two neighbours, their lengths), or
 * the no-op result when the index is out of range or a neighbouring segment has zero length.
 * Requires `poly.points.length >= 3`.
 */
function resolveCorner(
  doc: CadDocument,
  command: string,
  poly: PolylineEntity,
  vertexIndex: number,
): CornerResolution {
  const n = poly.points.length;
  const isValidIndex = poly.closed
    ? vertexIndex >= 0 && vertexIndex < n
    : vertexIndex >= 1 && vertexIndex <= n - 2;
  if (!isValidIndex) {
    return {
      ok: false,
      result: {
        document: doc,
        summary:
          `${command}: vertexIndex ${vertexIndex} is out of range for a ${poly.closed ? 'closed' : 'open'} polyline with ${n} points. ` +
          `Valid range: ${poly.closed ? `0..${n - 1}` : `1..${n - 2}`}.`,
        affected: [],
      },
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
      ok: false,
      result: {
        document: doc,
        summary: `${command}: degenerate segment at vertex ${vertexIndex} — zero-length segment.`,
        affected: [],
      },
    };
  }
  return { ok: true, vertex, toPrev, toNext, lenPrev, lenNext };
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
      .describe(
        '0-based index of the polyline vertex to fillet. ' +
          'For open polylines: valid range is 1 to N-2 (interior vertices). ' +
          'For closed polylines: valid range is 0 to N-1.',
      ),
  }),
  run: (doc, { id, radius, vertexIndex }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return noOp(doc, `fillet_2d: entity ${id} not found.`);
    }
    if (entity.kind !== 'polyline') {
      return noOp(doc, `fillet_2d: entity ${id} is kind '${entity.kind}', expected 'polyline'.`);
    }
    if (radius <= 0) {
      return noOp(doc, `fillet_2d: radius must be > 0 (got ${radius}).`);
    }

    const poly = entity as PolylineEntity;
    const n = poly.points.length;

    if (n < 3) {
      return noOp(
        doc,
        `fillet_2d: polyline ${id} needs at least 3 points to fillet a corner (got ${n}).`,
      );
    }

    const corner = resolveCorner(doc, 'fillet_2d', poly, vertexIndex);
    if (!corner.ok) return corner.result;
    const { vertex, toPrev, toNext, lenPrev, lenNext } = corner;

    const dirPrev = normalize2(toPrev);
    const dirNext = normalize2(toNext);

    // Half-angle between the two segments
    // cos(theta) = dot(dirPrev, dirNext)
    const cosA = Math.max(-1, Math.min(1, dot2(dirPrev, dirNext)));
    const halfAngle = Math.acos(cosA) / 2;

    if (halfAngle < 1e-9 || Math.abs(halfAngle - Math.PI / 2) < 1e-9) {
      // Lines are collinear or form a 180° angle — no fillet needed / not possible
      return noOp(
        doc,
        `fillet_2d: segments at vertex ${vertexIndex} are collinear — no fillet possible.`,
      );
    }

    // Distance from vertex to tangent points = radius / tan(halfAngle)
    const tanHalf = Math.tan(halfAngle);
    if (!isFinite(tanHalf) || tanHalf < 1e-12) {
      return noOp(doc, `fillet_2d: degenerate angle at vertex ${vertexIndex}.`);
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
});

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
      .describe(
        '0-based index of the polyline vertex to chamfer. ' +
          'For open polylines: valid range is 1 to N-2. ' +
          'For closed polylines: valid range is 0 to N-1.',
      ),
  }),
  run: (doc, { id, distance, vertexIndex }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return noOp(doc, `chamfer_2d: entity ${id} not found.`);
    }
    if (entity.kind !== 'polyline') {
      return noOp(doc, `chamfer_2d: entity ${id} is kind '${entity.kind}', expected 'polyline'.`);
    }
    if (distance <= 0) {
      return noOp(doc, `chamfer_2d: distance must be > 0 (got ${distance}).`);
    }

    const poly = entity as PolylineEntity;
    const n = poly.points.length;

    if (n < 3) {
      return noOp(
        doc,
        `chamfer_2d: polyline ${id} needs at least 3 points to chamfer a corner (got ${n}).`,
      );
    }

    const corner = resolveCorner(doc, 'chamfer_2d', poly, vertexIndex);
    if (!corner.ok) return corner.result;
    const { vertex, toPrev, toNext, lenPrev, lenNext } = corner;

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

    const bevelPrev: Vec2 = [vertex[0] + dirPrev[0] * distance, vertex[1] + dirPrev[1] * distance];
    const bevelNext: Vec2 = [vertex[0] + dirNext[0] * distance, vertex[1] + dirNext[1] * distance];

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
});
