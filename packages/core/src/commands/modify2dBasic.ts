import type { Entity, Vec2, Vec3, LineEntity, PolylineEntity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { offsetSegment, miterJoin } from './modify2dGeometry';
import { withEntity, withoutEntity } from './entityOps';

/**
 * @command explode_polyline
 * @pure
 * @layer core/commands
 * @affects removes 1 polyline, creates N line entities (N = number of segments)
 * @invariant source entity must be kind:'polyline' with >= 2 points
 * @failure missing id / wrong kind / < 2 points -> no-op, affected:[]
 */
export const explodePolyline = defineCommand({
  name: 'explode_polyline',
  description:
    'Explode a polyline entity into individual line segments. Each consecutive pair of vertices becomes a separate line entity. ' +
    'If the polyline is closed, a final segment is added from the last point back to the first. ' +
    'The original polyline is removed. No-op if the entity is not a polyline or has fewer than 2 points.',
  params: z.object({
    id: z.string().describe('Id of the polyline entity to explode.'),
  }),
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
});

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
export const offset2D = defineCommand({
  name: 'offset_2d',
  description:
    'Create a parallel-offset copy of a 2D shape at the given distance. ' +
    'Supported kinds: line (offset perpendicular to direction, positive=left of start→end), ' +
    'polyline (each segment offset then joined at miter intersections), ' +
    'circle (concentric: positive=larger, negative=smaller), ' +
    'rectangle (all sides expand/shrink: positive=outward, negative=inward). ' +
    'The original entity is unchanged; a new entity is added. ' +
    'No-op for unsupported kinds or if the resulting shape would be degenerate (e.g. negative circle radius).',
  params: z.object({
    id: z.string().describe('Id of the source entity to offset.'),
    distance: z
      .number()
      .describe(
        'Offset distance in work-plane units. Positive = left of direction (line/polyline) or outward (circle/rectangle). Negative reverses the direction.',
      ),
  }),
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
});
