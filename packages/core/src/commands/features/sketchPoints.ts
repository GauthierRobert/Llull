/** Hole centres taken from 2D sketch entities (point entities, polyline / line / rectangle vertices, circle and arc centres) as world points. */

import type { CadDocument, Entity, Vec2, Vec3 } from '../../model/types';
import { planeToWorld } from '../../geometry/workPlane';
import { z } from '../schema';

export const sketchPointsSchema = z
  .object({
    sketchEntityIds: z
      .array(z.string())
      .describe(
        'Ids of 2D sketch entities whose points become hole centres: a point entity gives its position; a polyline gives ALL its vertices; a ' +
          'line its two ends; a rectangle its four corners; a circle or arc its centre.',
      )
      .optional(),
    pointRefs: z
      .array(
        z.object({
          id: z.string().describe('Id of the sketch entity.'),
          vertex: z
            .number()
            .int()
            .nonnegative()
            .describe(
              'Vertex index in that entity (dimensionless): polyline point index; line 0 = start, 1 = end; rectangle 0..3 counter-clockwise from the lower-left ' +
                'corner; circle / arc / point 0.',
            ),
        }),
      )
      .describe('Single vertices of sketch entities (see vertex), for when only some vertices of a polyline should be drilled.')
      .optional(),
  })
  .describe(
    'Hole centres taken from a 2D sketch placed on the target face plane (the sketch plane must coincide with the face plane; a point off the ' +
      'plane is refused). Give sketchEntityIds, pointRefs or both.',
  );

export type SketchPointsSpec = z.infer<typeof sketchPointsSchema>;

/** Local plane vertices of a sketch entity, in index order; null for kinds without points. */
function vertices(entity: Entity): ReadonlyArray<Vec2> | null {
  switch (entity.kind) {
    case 'point':
      return [[0, 0]];
    case 'line':
      return [entity.start, entity.end];
    case 'polyline':
      return entity.points;
    case 'rectangle':
      return [
        [0, 0],
        [entity.width, 0],
        [entity.width, entity.height],
        [0, entity.height],
      ];
    case 'circle':
    case 'arc':
      return [entity.center];
    default:
      return null;
  }
}

/**
 * World points of the requested sketch vertices, with a label per point (`id#vertex`) for messages.
 * @failure unknown entity, kind without points, vertex out of range, nothing requested -> message
 */
export function resolveSketchPoints(doc: CadDocument, spec: SketchPointsSpec): { points: Vec3[]; labels: string[] } | string {
  const refs = [
    ...(spec.sketchEntityIds ?? []).map((id) => ({ id, vertex: null as number | null })),
    ...(spec.pointRefs ?? []).map(({ id, vertex }) => ({ id, vertex: vertex as number | null })),
  ];
  if (refs.length === 0) return 'points needs sketchEntityIds or pointRefs with at least one entry';
  const points: Vec3[] = [];
  const labels: string[] = [];
  for (const { id, vertex } of refs) {
    const entity = doc.entities[id];
    if (entity === undefined) return `sketch entity '${id}' not found`;
    const own = vertices(entity);
    if (own === null)
      return `entity '${id}' (kind '${entity.kind}') has no sketch points; use point, line, polyline, rectangle, circle or arc`;
    const picked =
      vertex === null
        ? own.map((local, index) => ({ local, index }))
        : own.flatMap((local, index) => (index === vertex ? [{ local, index }] : []));
    if (picked.length === 0) return `entity '${id}' has ${own.length} vertices; vertex ${vertex} does not exist`;
    for (const { local, index } of picked) {
      points.push(planeToWorld(entity.position, entity.rotation, local));
      labels.push(`${id}#${index}`);
    }
  }
  return { points, labels };
}
