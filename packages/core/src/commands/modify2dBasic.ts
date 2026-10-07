import type { Entity, Vec2 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { offsetSegment, miterJoin, resolvePolyline } from './modify2dGeometry';
import { commitEntity } from './commitEntity';
import { withEntities, withoutEntities } from './entityOps';
import { newEntity } from './newEntity';
import { noop } from './noop';
import { elementAt } from '../lib/elementAt';

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
    const polyline = resolvePolyline(doc, 'explode_polyline', id);
    if ('summary' in polyline) return polyline;
    if (polyline.points.length < 2) {
      return noop(
        doc,
        `explode_polyline: polyline ${id} has fewer than 2 points — nothing to explode.`,
      );
    }

    const ring = polyline.closed
      ? [...polyline.points, elementAt(polyline.points, 0)]
      : polyline.points;
    const segments = ring.slice(1).map((end, i): [Vec2, Vec2] => [elementAt(ring, i), end]);

    // Remove the polyline, add one line per segment
    const baseDoc = withoutEntities(doc, new Set([id])).document;
    const createdIds: string[] = [];
    const lines: Entity[] = [];
    for (const [start, end] of segments) {
      const lineId = nextId('line');
      createdIds.push(lineId);
      const line = newEntity('line', lineId, { start, end }, polyline.position, polyline.color, {
        rotation: polyline.rotation,
        layerId: polyline.layerId,
      });
      lines.push(line);
    }
    const newDoc = withEntities(baseDoc, lines);

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
      return noop(doc, `offset_2d: entity ${id} not found.`);
    }
    if (distance === 0) {
      return noop(doc, `offset_2d: distance is 0 — no-op.`);
    }

    const newId = nextId('offset');
    const base = {
      position: entity.position,
      rotation: entity.rotation,
      layerId: entity.layerId,
      color: entity.color,
    };
    let offsetEntity: Entity;
    let summary: string;

    switch (entity.kind) {
      case 'line': {
        const [start, end] = offsetSegment(entity.start, entity.end, distance);
        offsetEntity = { ...base, id: newId, kind: 'line', start, end };
        summary = `Offset line ${id} by ${distance} → new line ${newId}.`;
        break;
      }
      case 'polyline': {
        const pts = entity.points;
        if (pts.length < 2) {
          return noop(doc, `offset_2d: polyline ${id} has fewer than 2 points — no-op.`);
        }
        const segs = pts
          .slice(0, -1)
          .map((p, i) => offsetSegment(p, elementAt(pts, i + 1), distance));
        if (entity.closed)
          segs.push(offsetSegment(elementAt(pts, pts.length - 1), elementAt(pts, 0), distance));
        const joins = (entity.closed ? segs : segs.slice(1)).map((seg, i) => {
          const prev = elementAt(segs, entity.closed ? (i - 1 + segs.length) % segs.length : i);
          return miterJoin(prev[0], prev[1], seg[0], seg[1]);
        });
        const points: Vec2[] = entity.closed
          ? joins
          : [elementAt(segs, 0)[0], ...joins, elementAt(segs, segs.length - 1)[1]];
        offsetEntity = { ...base, id: newId, kind: 'polyline', points, closed: entity.closed };
        summary = `Offset polyline ${id} by ${distance} → new polyline ${newId} (${points.length} points).`;
        break;
      }
      case 'circle': {
        const radius = entity.radius + distance;
        if (radius <= 0) {
          return noop(doc, `offset_2d: resulting circle radius ${radius} <= 0 — no-op.`);
        }
        offsetEntity = { ...base, id: newId, kind: 'circle', center: entity.center, radius };
        summary = `Offset circle ${id} by ${distance} → new circle ${newId} radius ${radius}.`;
        break;
      }
      case 'rectangle': {
        const width = entity.width + 2 * distance;
        const height = entity.height + 2 * distance;
        if (width <= 0 || height <= 0) {
          return noop(
            doc,
            `offset_2d: resulting rectangle ${width}×${height} is degenerate — no-op.`,
          );
        }
        // The origin shifts by -distance on X and Y so the rectangle grows/shrinks on every side.
        const [x, y, z] = entity.position;
        offsetEntity = {
          ...base,
          id: newId,
          kind: 'rectangle',
          width,
          height,
          position: [x - distance, y - distance, z],
        };
        summary = `Offset rectangle ${id} by ${distance} → new rectangle ${newId} ${width}×${height}.`;
        break;
      }
      default:
        return noop(
          doc,
          `offset_2d: entity ${id} has unsupported kind '${entity.kind}'. Supported: line, polyline, circle, rectangle.`,
        );
    }

    return commitEntity(doc, offsetEntity, summary);
  },
});
