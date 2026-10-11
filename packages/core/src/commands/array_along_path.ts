/**
 * Path and arc distribution: copies of a source entity along a polyline (`array_along_path`) or a
 * circular arc (`distribute_on_arc`, copies face radially outward). The source is untouched.
 *
 * @layer core/commands
 */

import type { Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { MAX_COPIES_PER_COMMAND, MAX_PROFILE_POINTS } from './limits';
import { addCopies } from './transform';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3, distance3 } from '../lib/vec3';
import { changed, noop } from './noop';
import { elementAt } from '../lib/elementAt';

function polylineLength(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += distance3(elementAt(path, i), elementAt(path, i - 1));
  }
  return total;
}

/** World position at arc length `t` along the polyline (t in [0, total]). */
function pointAtArcLength(path: Vec3[], t: number): Vec3 {
  let remaining = t;
  for (let i = 1; i < path.length; i++) {
    const seg = sub3(elementAt(path, i), elementAt(path, i - 1));
    const segLen = distance3(elementAt(path, i), elementAt(path, i - 1));
    if (remaining <= segLen + 1e-10)
      return add3(elementAt(path, i - 1), scale3(normalize3(seg), remaining));
    remaining -= segLen;
  }
  return elementAt(path, path.length - 1);
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
    count: z.number().int().describe('Number of copies to place. Must be an integer >= 1.'),
    mode: z
      .string()
      .optional()
      .describe(
        '"place" (default): independent copies. "instance": treated as place in the current version.',
      ),
  }),
  run: (doc, { sourceId, path, count }): CommandResult => {
    const source = doc.entities[sourceId];
    if (!source) return noop(doc, `array_along_path: source entity "${sourceId}" not found.`);
    if (path.length < 2) {
      return noop(
        doc,
        `array_along_path: path must contain at least 2 points (got ${path.length}).`,
      );
    }
    if (path.length > MAX_PROFILE_POINTS) {
      return noop(
        doc,
        `array_along_path: path has ${path.length} points, exceeding MAX_PROFILE_POINTS (${MAX_PROFILE_POINTS}).`,
      );
    }
    if (count < 1 || count > MAX_COPIES_PER_COMMAND) {
      return noop(
        doc,
        `array_along_path: count must be in [1, ${MAX_COPIES_PER_COMMAND}] (got ${count}).`,
      );
    }

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
        return noop(doc, `array_along_path: path[${i}] is not a valid [x,y,z] triple.`);
      }
      validatedPath.push([pt[0] as number, pt[1] as number, pt[2] as number]);
    }

    const intCount = count;
    const totalLen = polylineLength(validatedPath);

    const step = intCount === 1 ? 0 : totalLen / (intCount - 1);
    const { document: newDoc, newIds: createdIds } = addCopies(
      doc,
      source,
      Array.from({ length: intCount }, (_, i) => ({
        position: pointAtArcLength(validatedPath, intCount === 1 ? totalLen / 2 : i * step),
      })),
      'e',
    );

    return changed(
      newDoc,
      `array_along_path: placed ${createdIds.length} cop${createdIds.length === 1 ? 'y' : 'ies'} of "${sourceId}" along path of ${validatedPath.length} points (total length ${totalLen.toFixed(3)}).`,
      createdIds,
    );
  },
});

/**
 * @command distribute_on_arc
 * @pure
 * @layer core/commands
 * @affects creates `count` new entities placed on a circular arc; each is rotated to face radially outward
 * @invariant count >= 1; radius > 0; normal non-zero; source entity must exist
 * @failure count < 1 -> no-op; radius <= 0 or zero normal -> no-op; missing sourceId -> no-op
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
    count: z.number().int().describe('Number of copies to place. Must be an integer >= 1.'),
  }),
  run: (doc, { sourceId, center, normal, radius, startAngle, endAngle, count }): CommandResult => {
    const source = doc.entities[sourceId];
    if (!source) return noop(doc, `distribute_on_arc: source entity "${sourceId}" not found.`);
    if (radius <= 0) return noop(doc, `distribute_on_arc: radius must be > 0 (got ${radius}).`);
    if (count < 1 || count > MAX_COPIES_PER_COMMAND) {
      return noop(
        doc,
        `distribute_on_arc: count must be in [1, ${MAX_COPIES_PER_COMMAND}] (got ${count}).`,
      );
    }
    if (center.length < 3) return noop(doc, 'distribute_on_arc: center must be a [x,y,z] triple.');
    if (normal.length < 3) return noop(doc, 'distribute_on_arc: normal must be a [x,y,z] triple.');

    if (len3([normal[0] as number, normal[1] as number, normal[2] as number]) < 1e-10)
      return noop(doc, 'distribute_on_arc: normal must be a non-zero vector.');

    const c: Vec3 = [center[0] as number, center[1] as number, center[2] as number];
    const n: Vec3 = normalize3([normal[0] as number, normal[1] as number, normal[2] as number]);

    // In-plane frame: u = local +X (startAngle origin), v = n × u.
    const u = buildPerpendicularInPlane(n);
    const v = cross3(n, u);

    const intCount = count;
    const angleRange = endAngle - startAngle;
    // Full circle: step = range/count (first and last copies must not coincide).
    const isFullCircle = Math.abs(Math.abs(angleRange) - Math.PI * 2) < 1e-9;

    const angles = Array.from({ length: intCount }, (_, i) =>
      intCount === 1
        ? startAngle + angleRange / 2
        : startAngle + (angleRange / (isFullCircle ? intCount : intCount - 1)) * i,
    );
    const { document: newDoc, newIds: createdIds } = addCopies(
      doc,
      source,
      angles.map((angle) => ({
        position: add3(
          c,
          scale3(add3(scale3(u, Math.cos(angle)), scale3(v, Math.sin(angle))), radius),
        ),
        rotation: rotationForRadial(n, angle),
      })),
      'e',
    );

    return changed(
      newDoc,
      `distribute_on_arc: placed ${createdIds.length} cop${createdIds.length === 1 ? 'y' : 'ies'} of "${sourceId}" on arc r=${radius}, angles [${startAngle.toFixed(3)}, ${endAngle.toFixed(3)}].`,
      createdIds,
    );
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

/** Euler XYZ rotation about the dominant axis of `normal` (sign-corrected) turning local +X by `angle`. */
function rotationForRadial(normal: Vec3, angle: number): Vec3 {
  const [nx, ny, nz] = normal;
  const abx = Math.abs(nx),
    aby = Math.abs(ny),
    abz = Math.abs(nz);

  if (abz >= abx && abz >= aby) {
    return [0, 0, nz >= 0 ? angle : -angle];
  } else if (aby >= abx) {
    return [0, ny >= 0 ? angle : -angle, 0];
  } else {
    return [nx >= 0 ? angle : -angle, 0, 0];
  }
}
