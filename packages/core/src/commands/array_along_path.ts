/**
 * Path and arc distribution commands.
 *
 * @layer core/commands
 *
 * Two pure commands that place copies of a source entity along a geometric path:
 *
 *   array_along_path  — duplicate/instance sourceId at evenly-spaced positions
 *                       along a polyline path defined by Vec3 points.
 *   distribute_on_arc — duplicate sourceId at evenly-spaced positions along a
 *                       circular arc; each copy is rotated to face radially outward.
 *
 * Both commands never mutate the input document; they create NEW entities with
 * fresh ids via nextId(). The source entity is NOT removed or altered.
 */

import type { Entity, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { nextId } from '../lib/id';
import { MAX_COPIES_PER_COMMAND } from './limits';
import { DEFAULT_LAYER_ID } from '../model/types';
import { withEntity } from './entityOps';
import { add3, cross3, distanceSq3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';

/** Total arc length of the polyline. */
function polylineLength(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.sqrt(distanceSq3(path[i]!, path[i - 1]!));
  }
  return total;
}

/**
 * Find the world position at a given arc-length `t` along a polyline.
 * `t` must be in [0, totalLength].
 */
function pointAtArcLength(path: Vec3[], t: number): Vec3 {
  let remaining = t;
  for (let i = 1; i < path.length; i++) {
    const seg = sub3(path[i]!, path[i - 1]!);
    const segLen = Math.sqrt(distanceSq3(path[i]!, path[i - 1]!));
    if (remaining <= segLen + 1e-10) {
      return add3(path[i - 1]!, scale3(normalize3(seg), remaining));
    }
    remaining -= segLen;
  }
  return path[path.length - 1]!;
}

/**
 * Shallow-clone an entity with a new id and new position/rotation, preserving all
 * other properties (kind, size, radius, etc.). Pure — never mutates the original.
 */
function cloneEntityAt(source: Entity, newId: string, position: Vec3, rotation: Vec3): Entity {
  return { ...source, id: newId, position, rotation } as Entity;
}

/**
 * @command array_along_path
 * @pure
 * @layer core/commands
 * @affects creates `count` new entities (copies of sourceId) placed at evenly-spaced positions along path
 * @invariant count >= 1; path.length >= 2; source entity must exist
 * @failure count < 1 -> no-op; path < 2 points -> no-op; missing sourceId -> no-op
 */
export const arrayAlongPath = defineCommand({
  name: 'array_along_path',
  description:
    'Duplicate sourceId at evenly-spaced positions along the polyline defined by path (array of [x,y,z] points). ' +
    'count is the number of copies to place (including one at the start and one at the end when count >= 2). ' +
    'mode="place" (default): creates independent copies. ' +
    'mode="instance": future — currently treated as "place". ' +
    'The source entity is not removed. Returns affected: ids of all newly created entities.',
  params: z.object({
    sourceId: z.string().describe('Id of the entity to duplicate along the path.'),
    path: z
      .array(z.array(z.any()))
      .describe(
        'Polyline path as an array of [x,y,z] points. Minimum 2 points. ' +
          'Copies are placed at evenly-spaced arc-length positions from the first to the last point.',
      ),
    count: z.number().describe('Number of copies to place. Must be >= 1.'),
    mode: z
      .string()
      .optional()
      .describe(
        '"place" (default): independent copies. "instance": treated as place in the current version.',
      ),
  }),
  run: (doc, { sourceId, path, count }): CommandResult => {
    const source = doc.entities[sourceId];
    if (!source) {
      return {
        document: doc,
        summary: `array_along_path: source entity "${sourceId}" not found.`,
        affected: [],
      };
    }
    if (!Array.isArray(path) || path.length < 2) {
      return {
        document: doc,
        summary: `array_along_path: path must contain at least 2 points (got ${Array.isArray(path) ? path.length : 'non-array'}).`,
        affected: [],
      };
    }
    if (!Number.isFinite(count) || count < 1 || count > MAX_COPIES_PER_COMMAND) {
      return {
        document: doc,
        summary: `array_along_path: count must be in [1, ${MAX_COPIES_PER_COMMAND}] (got ${count}).`,
        affected: [],
      };
    }

    // Validate path points are Vec3.
    const validatedPath: Vec3[] = [];
    for (let i = 0; i < path.length; i++) {
      const pt = path[i];
      if (
        !Array.isArray(pt) ||
        pt.length < 3 ||
        !Number.isFinite(pt[0]) ||
        !Number.isFinite(pt[1]) ||
        !Number.isFinite(pt[2])
      ) {
        return {
          document: doc,
          summary: `array_along_path: path[${i}] is not a valid [x,y,z] triple.`,
          affected: [],
        };
      }
      validatedPath.push([pt[0] as number, pt[1] as number, pt[2] as number]);
    }

    const intCount = Math.max(1, Math.round(count));
    const totalLen = polylineLength(validatedPath);

    let newDoc = doc;
    const createdIds: string[] = [];

    if (intCount === 1) {
      // Place a single copy at the midpoint.
      const pos = pointAtArcLength(validatedPath, totalLen / 2);
      const id = nextId('e');
      const newEntity = cloneEntityAt(source, id, pos, source.rotation);
      newDoc = withEntity(newDoc, { ...newEntity, layerId: source.layerId || DEFAULT_LAYER_ID });
      createdIds.push(id);
    } else {
      // Place count copies at evenly-spaced arc-length positions [0 .. totalLen].
      const step = totalLen / (intCount - 1);
      for (let i = 0; i < intCount; i++) {
        const t = i * step;
        const pos = pointAtArcLength(validatedPath, t);
        const id = nextId('e');
        const newEntity = cloneEntityAt(source, id, pos, source.rotation);
        newDoc = withEntity(newDoc, { ...newEntity, layerId: source.layerId || DEFAULT_LAYER_ID });
        createdIds.push(id);
      }
    }

    return {
      document: newDoc,
      summary: `array_along_path: placed ${createdIds.length} cop${createdIds.length === 1 ? 'y' : 'ies'} of "${sourceId}" along path of ${validatedPath.length} points (total length ${totalLen.toFixed(3)}).`,
      affected: createdIds,
    };
  },
});

/**
 * @command distribute_on_arc
 * @pure
 * @layer core/commands
 * @affects creates `count` new entities placed on a circular arc; each is rotated to face radially outward
 * @invariant count >= 1; radius > 0; source entity must exist
 * @failure count < 1 -> no-op; radius <= 0 -> no-op; missing sourceId -> no-op
 */
export const distributeOnArc = defineCommand({
  name: 'distribute_on_arc',
  description:
    'Duplicate sourceId at evenly-spaced angular positions along a circular arc. ' +
    'center is the [x,y,z] arc center; normal is the arc plane normal (unit vector, e.g. [0,0,1] for XY-plane arc); ' +
    'radius is the arc radius (must be > 0); ' +
    'startAngle and endAngle are the sweep range in radians (e.g. 0 to 2π for a full circle); ' +
    'count is the number of copies (must be >= 1). ' +
    'Each copy is rotated so that its local +X axis points radially outward from the center. ' +
    'The source entity is not removed. Returns affected: ids of all newly created entities.',
  params: z.object({
    sourceId: z.string().describe('Id of the entity to distribute around the arc.'),
    center: vec3('World-space [x,y,z] center of the arc.'),
    normal: vec3('Unit normal of the arc plane, e.g. [0,0,1] for arcs in the XY plane.'),
    radius: z.number().describe('Radius of the arc. Must be > 0.'),
    startAngle: z
      .number()
      .describe(
        "Start angle of the arc sweep in radians (measured from the plane's local +X axis).",
      ),
    endAngle: z.number().describe('End angle of the arc sweep in radians.'),
    count: z.number().describe('Number of copies to place. Must be >= 1.'),
  }),
  run: (doc, { sourceId, center, normal, radius, startAngle, endAngle, count }): CommandResult => {
    const source = doc.entities[sourceId];
    if (!source) {
      return {
        document: doc,
        summary: `distribute_on_arc: source entity "${sourceId}" not found.`,
        affected: [],
      };
    }
    if (!Number.isFinite(radius) || radius <= 0) {
      return {
        document: doc,
        summary: `distribute_on_arc: radius must be > 0 (got ${radius}).`,
        affected: [],
      };
    }
    if (!Number.isFinite(count) || count < 1 || count > MAX_COPIES_PER_COMMAND) {
      return {
        document: doc,
        summary: `distribute_on_arc: count must be in [1, ${MAX_COPIES_PER_COMMAND}] (got ${count}).`,
        affected: [],
      };
    }
    if (!Array.isArray(center) || center.length < 3) {
      return {
        document: doc,
        summary: 'distribute_on_arc: center must be a [x,y,z] triple.',
        affected: [],
      };
    }
    if (!Array.isArray(normal) || normal.length < 3) {
      return {
        document: doc,
        summary: 'distribute_on_arc: normal must be a [x,y,z] triple.',
        affected: [],
      };
    }

    const c: Vec3 = [center[0] as number, center[1] as number, center[2] as number];
    const n: Vec3 = normalize3([normal[0] as number, normal[1] as number, normal[2] as number]);

    // Build a local coordinate frame in the arc plane.
    // u = local +X (from which startAngle is measured), v = local +Y = n × u.
    const u = buildPerpendicularInPlane(n);
    const v = cross3(n, u);

    const intCount = Math.max(1, Math.round(count));
    const angleRange = endAngle - startAngle;
    // Full circle (sweep ≈ 2π): step = range/count so the first and last
    // copies don't collide. Partial arc: step = range/(count-1) so endpoints
    // are included.
    const isFullCircle = Math.abs(Math.abs(angleRange) - Math.PI * 2) < 1e-9;

    let newDoc = doc;
    const createdIds: string[] = [];

    for (let i = 0; i < intCount; i++) {
      // Angle for this copy.
      const angle =
        intCount === 1
          ? startAngle + angleRange / 2
          : isFullCircle
            ? startAngle + (angleRange / intCount) * i
            : startAngle + (angleRange / (intCount - 1)) * i;

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      // World position on the arc.
      const radial: Vec3 = add3(scale3(u, cosA), scale3(v, sinA));
      const pos: Vec3 = add3(c, scale3(radial, radius));

      // Radial rotation: derive Euler ZYX from radial direction.
      // For the common case of normal=[0,0,1] (XY plane), the entity rotates
      // about Z by `angle`. For other normals we compute a general rotation.
      const rotation = rotationForRadial(n, angle);

      const id = nextId('e');
      const newEntity = cloneEntityAt(source, id, pos, rotation);
      newDoc = withEntity(newDoc, { ...newEntity, layerId: source.layerId || DEFAULT_LAYER_ID });
      createdIds.push(id);
    }

    return {
      document: newDoc,
      summary: `distribute_on_arc: placed ${createdIds.length} cop${createdIds.length === 1 ? 'y' : 'ies'} of "${sourceId}" on arc r=${radius}, angles [${startAngle.toFixed(3)}, ${endAngle.toFixed(3)}].`,
      affected: createdIds,
    };
  },
});

/**
 * Build a unit vector that is perpendicular to `n` and lies in the plane
 * defined by `n`. This is the local +X axis of the arc plane.
 */
function buildPerpendicularInPlane(n: Vec3): Vec3 {
  // Pick a vector not parallel to n, then project out the n component.
  const candidate: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize3(sub3(candidate, scale3(n, dot3(candidate, n))));
}

/**
 * Compute an Euler XYZ rotation (in radians) such that the entity's local +X
 * points radially outward at `angle`. For the common case of normal=[0,0,1] this
 * reduces to a pure Z rotation of `angle`.
 *
 * We use the convention: rotation about [normal axis] by `angle` degrees.
 * The axis-angle → Euler conversion is done via the rotation matrix of
 * Rodrigues' formula projected to intrinsic XYZ Euler angles.
 */
function rotationForRadial(normal: Vec3, angle: number): Vec3 {
  // For simplicity, for the common XY-plane case (normal ≈ Z), rotate about Z.
  // For Y-axis normal, rotate about Y. For X-axis normal, rotate about X.
  // For other normals, compose the rotation.
  const [nx, ny, nz] = normal;
  const abx = Math.abs(nx),
    aby = Math.abs(ny),
    abz = Math.abs(nz);

  if (abz >= abx && abz >= aby) {
    // Normal is mostly Z — rotate about Z.
    return [0, 0, nz >= 0 ? angle : -angle];
  } else if (aby >= abx) {
    // Normal is mostly Y — rotate about Y.
    return [0, ny >= 0 ? angle : -angle, 0];
  } else {
    // Normal is mostly X — rotate about X.
    return [nx >= 0 ? angle : -angle, 0, 0];
  }
}
