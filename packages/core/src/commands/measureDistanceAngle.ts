import type { Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, vec3, z } from './schema';
import { formatLength } from './units';
import { boundsCenter, entityBounds } from './sceneBounds';
import { distanceSq3, dot3, sub3 } from '../lib/vec3';
import { noop } from './noop';
interface MeasureDistanceData {
  distance: number;
  unit: string;
}

/**
 * @command measure_distance
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { distance: number, unit: string }
 * @failure missing entity id or neither point nor entity provided -> no-op, affected:[], no data
 */
export const measureDistance = defineCommand({
  name: 'measure_distance',
  annotations: { readOnly: true },
  description:
    'Measure the straight-line distance between two locations. Each location may be a world-space ' +
    'point [x,y,z] (point1/point2) or an entity id (entityId1/entityId2, centroid used). ' +
    'Mix point and entity freely (e.g. point1 + entityId2). ' +
    'Returns data: { distance, unit } and a factual summary. Does not modify the document.',
  params: z.object({
    point1: vec3(
      'First world-space point [x, y, z]. Omit to use entityId1 centroid instead.',
    ).optional(),
    point2: vec3(
      'Second world-space point [x, y, z]. Omit to use entityId2 centroid instead.',
    ).optional(),
    entityId1: z
      .string()
      .optional()
      .describe(
        'Id of the first entity. Its bounding-box centroid is used as the first location ' +
          'when point1 is not provided.',
      ),
    entityId2: z
      .string()
      .optional()
      .describe(
        'Id of the second entity. Its bounding-box centroid is used as the second location ' +
          'when point2 is not provided.',
      ),
  }),
  run: (doc, { point1, point2, entityId1, entityId2 }): CommandResult => {
    let locA: Vec3 | undefined;
    if (point1) {
      locA = point1;
    } else if (entityId1) {
      const e = doc.entities[entityId1];
      if (!e) {
        return noop(doc, `measure_distance: entity '${entityId1}' not found.`);
      }
      locA = boundsCenter(entityBounds(e));
    }

    let locB: Vec3 | undefined;
    if (point2) {
      locB = point2;
    } else if (entityId2) {
      const e = doc.entities[entityId2];
      if (!e) {
        return noop(doc, `measure_distance: entity '${entityId2}' not found.`);
      }
      locB = boundsCenter(entityBounds(e));
    }

    if (!locA || !locB) {
      return noop(
        doc,
        'measure_distance: provide two locations — each as a point [x,y,z] (point1/point2) ' +
          'or an entity id (entityId1/entityId2).',
      );
    }

    const distance = Math.sqrt(distanceSq3(locA, locB));
    const data: MeasureDistanceData = { distance, unit: doc.units };
    return {
      document: doc,
      summary: `Distance = ${formatLength(doc, distance)}.`,
      affected: [],
      data,
    };
  },
});

const POINT_3D = z.tuple([z.number(), z.number(), z.number()]);

interface MeasureAngleData {
  degrees: number;
  radians: number;
}

/**
 * @command measure_angle
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { degrees: number, radians: number }
 * @failure degenerate vectors (zero-length) or missing entity ids -> no-op, affected:[], no data
 */
export const measureAngle = defineCommand({
  name: 'measure_angle',
  annotations: { readOnly: true },
  description:
    'Measure an angle. Provide either: (a) three world-space points as [[vx,vy,vz],[a1x,a1y,a1z],[a2x,a2y,a2z]] ' +
    'where the first point is the vertex and the angle is between the two rays vertex→arm1 and vertex→arm2; or ' +
    '(b) two line entity ids (lineId1, lineId2) to measure the angle between their direction vectors. ' +
    'Returns data: { degrees, radians }. Does not modify the document.',
  params: z.object({
    points: z
      .tuple([POINT_3D, POINT_3D, POINT_3D])
      .optional()
      .describe(
        'Three world-space points [[vx,vy,vz],[a1x,a1y,a1z],[a2x,a2y,a2z]]. ' +
          'First is the vertex; angle is measured between rays vertex→point[1] and vertex→point[2].',
      ),
    lineId1: z
      .string()
      .optional()
      .describe(
        "Id of the first 'line' entity. Used together with lineId2 to measure the angle between two lines.",
      ),
    lineId2: z.string().optional().describe("Id of the second 'line' entity."),
  }),
  run: (doc, { points, lineId1, lineId2 }): CommandResult => {
    let vA: Vec3, vB: Vec3;

    if (points) {
      const [vertex, arm1, arm2] = points;
      vA = sub3(arm1, vertex);
      vB = sub3(arm2, vertex);
    } else if (lineId1 && lineId2) {
      const e1 = doc.entities[lineId1];
      const e2 = doc.entities[lineId2];
      if (!e1) {
        return noop(doc, `measure_angle: entity '${lineId1}' not found.`);
      }
      if (!e2) {
        return noop(doc, `measure_angle: entity '${lineId2}' not found.`);
      }
      if (e1.kind !== 'line') {
        return noop(
          doc,
          `measure_angle: entity '${lineId1}' is kind '${e1.kind}', expected 'line'.`,
        );
      }
      if (e2.kind !== 'line') {
        return noop(
          doc,
          `measure_angle: entity '${lineId2}' is kind '${e2.kind}', expected 'line'.`,
        );
      }
      vA = [e1.end[0] - e1.start[0], e1.end[1] - e1.start[1], 0];
      vB = [e2.end[0] - e2.start[0], e2.end[1] - e2.start[1], 0];
    } else {
      return noop(
        doc,
        'measure_angle: provide either points (3 world-space points) or lineId1 + lineId2.',
      );
    }

    const lenA = Math.sqrt(dot3(vA, vA));
    const lenB = Math.sqrt(dot3(vB, vB));
    if (lenA < 1e-12 || lenB < 1e-12) {
      return noop(doc, 'measure_angle: degenerate vector (zero length) — cannot compute angle.');
    }

    const radians = Math.acos(Math.max(-1, Math.min(1, dot3(vA, vB) / (lenA * lenB))));
    const degrees = (radians * 180) / Math.PI;
    const data: MeasureAngleData = { degrees, radians };
    return {
      document: doc,
      summary: `Angle = ${degrees.toFixed(doc.displayPrecision)}° (${radians.toFixed(doc.displayPrecision)} rad).`,
      affected: [],
      data,
    };
  },
});
