/**
 * pattern_along_path: copies of an entity laid along a curve and oriented by the curve's
 * rotation-minimizing frame (the same frame sweeps use) — chain links, tyre tread blocks, sprocket
 * teeth, fence posts, rivets along a seam.
 *
 * @layer core/commands
 */

import type { CurveSegment } from '../../model/curve';
import type { Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, untypedArray, z } from '../schema';
import { changed, noop } from '../noop';
import { MAX_COPIES_PER_COMMAND, MAX_PROFILE_POINTS } from '../limits';
import { add3, cross3, scale3 } from '../../lib/vec3';
import { composeEulerXYZ, eulerFromAxes } from '../../lib/eulerRotation';
import {
  catmullRomBeziers,
  chainIssue,
  chainLength,
  isClosedChain,
} from '../../geometry/curveSegments';
import { frameAtFraction } from '../../geometry/sweep';
import { sketchPath } from '../solids/sketchCurves';
import { addCopies } from './transform';

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/** Path chain from points (polyline or smooth spline, open or closed) or a sketch, or a message. */
function patternPath(
  doc: Parameters<typeof sketchPath>[0],
  path: ReadonlyArray<unknown> | undefined,
  pathId: string | undefined,
  smooth: boolean,
  closed: boolean,
): CurveSegment<Vec3>[] | string {
  if ((path === undefined) === (pathId === undefined)) return 'give exactly one of path or pathId';
  if (pathId !== undefined) return sketchPath(doc, pathId);
  const raw = path as ReadonlyArray<unknown>;
  const bad = raw.findIndex((point) => !isVec3(point));
  if (bad >= 0) return `path point ${bad} must be a finite [x, y, z] triple`;
  const points = raw as Vec3[];
  if (points.length < 2 || points.length > MAX_PROFILE_POINTS)
    return `path needs 2..${MAX_PROFILE_POINTS} points (got ${points.length})`;
  if (smooth) return catmullRomBeziers(points, closed);
  const loop = closed ? [...points, points[0] as Vec3] : points;
  return loop
    .slice(1)
    .map((point, i): CurveSegment<Vec3> => ({ type: 'line', points: [loop[i] as Vec3, point] }));
}

/**
 * @command pattern_along_path
 * @pure
 * @layer core/commands
 * @affects creates `count` copies of the source along the path (source untouched)
 * @invariant copy k sits at path fraction k/(count-1) (open) or k/count (closed loop); its local
 *   +X follows the tangent, +Y the frame normal, +Z the binormal, then rolls k·rollStep about +X
 * @failure missing source, bad count, bad / ambiguous path -> no-op, affected:[]
 */
export const patternAlongPath = defineCommand({
  name: 'pattern_along_path',
  description:
    'Lay copies of an entity along a curve, each ORIENTED by the curve: chain links round a chainring ' +
    'and cassette loop, tyre tread blocks round a tyre, sprocket / gear teeth, cable clips, rivets, ' +
    'fence posts. Model the source at the world origin in its "along the path" pose: its local +X ' +
    'follows the path tangent, +Y the path normal, +Z the binormal (≈ world up on a horizontal path); ' +
    'copies rotate about their position. rollStep adds an extra roll about the tangent per copy ' +
    '(π/2 alternates chain plates). Path: `pathId` (a 2D sketch curve: line, arc, polyline, spline, ' +
    'circle, ellipse, rectangle; open or closed) or `path` points (straight runs, or smooth: true for ' +
    'a spline; closed: true loops back). Open paths put copies at both ends; closed loops space ' +
    'count copies evenly all round. The source is kept.',
  params: z.object({
    sourceId: z.string().describe('Id of the entity to copy (2D or 3D).'),
    count: z.number().int().describe(`Number of copies, 1..${MAX_COPIES_PER_COMMAND}.`),
    pathId: z
      .string()
      .describe('Id of a 2D sketch curve to follow (placed by its own work plane).')
      .optional(),
    path: untypedArray(
      'World [x, y, z] points of the path (>= 2). Alternative to pathId.',
    ).optional(),
    smooth: z
      .boolean()
      .describe('With path points: a smooth spline through them (default: straight runs).')
      .optional(),
    closed: z
      .boolean()
      .describe('With path points: loop back from the last point to the first.')
      .optional(),
    rollStep: z
      .number()
      .describe('Extra roll about the tangent added per copy, in radians (default 0).')
      .optional(),
  }),
  run: (
    doc,
    { sourceId, count, pathId, path: rawPath, smooth = false, closed = false, rollStep = 0 },
  ): CommandResult => {
    const fail = (why: string): CommandResult => noop(doc, `pattern_along_path: ${why}; no-op.`);
    const source = doc.entities[sourceId];
    if (!source) return fail(`source entity "${sourceId}" not found`);
    if (count < 1 || count > MAX_COPIES_PER_COMMAND)
      return fail(`count must be in [1, ${MAX_COPIES_PER_COMMAND}] (got ${count})`);
    const path = patternPath(doc, rawPath, pathId, smooth, closed);
    if (typeof path === 'string') return fail(path);
    const loop = isClosedChain(path);
    const issue = chainIssue(path, loop);
    if (issue !== null) return fail(`path invalid — ${issue}`);
    const placements = Array.from({ length: count }, (_, k) => {
      const t = loop ? k / count : count === 1 ? 0 : k / (count - 1);
      const { point, normal, binormal } = frameAtFraction(path, t);
      const tangent = cross3(normal, binormal);
      const roll = rollStep * k;
      const y = add3(scale3(normal, Math.cos(roll)), scale3(binormal, Math.sin(roll)));
      const z = cross3(tangent, y);
      return {
        position: point,
        rotation: composeEulerXYZ(eulerFromAxes(tangent, y, z), source.rotation),
      };
    });
    const { document, newIds } = addCopies(doc, source, placements);
    return changed(
      document,
      `pattern_along_path: placed ${newIds.length} oriented cop${newIds.length === 1 ? 'y' : 'ies'} of "${sourceId}" along a ${loop ? 'closed' : 'open'} path (length ${chainLength(path).toFixed(3)}).`,
      newIds,
    );
  },
});
