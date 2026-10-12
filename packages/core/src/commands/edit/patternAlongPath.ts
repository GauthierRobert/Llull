/**
 * pattern_along_path: copies of an entity (or fresh instances of a component) laid along a curve —
 * a polyline/spline, a sketch curve or a circular arc — optionally oriented by the curve's
 * rotation-minimizing frame (the same frame sweeps use): chain links, tyre tread blocks, sprocket
 * teeth, fence posts, rivets along a seam, parts fanned round an arc.
 *
 * @layer core/commands
 */

import type { CurveSegment } from '../../model/curve';
import type { Entity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, looseVec3, untypedArray, z } from '../schema';
import { changed, failer } from '../noop';
import { MAX_COPIES_PER_COMMAND, MAX_PROFILE_POINTS } from '../limits';
import { add3, cross3, isVec3, scale3, ORIGIN } from '../../lib/vec3';
import { composeEulerXYZ, eulerFromAxes } from '../../lib/eulerRotation';
import {
  catmullRomBeziers,
  chainIssue,
  chainLength,
  isClosedChain,
} from '../../geometry/curveSegments';
import { frameAtFraction } from '../../geometry/sweep';
import { sketchPath } from '../solids/sketchCurves';
import { instanceEntity } from '../assembly/assemblies';
import { arcPath, type ArcSpec } from './arcPath';
import { addCopies } from './transform';

interface PathSource {
  readonly path: ReadonlyArray<unknown> | undefined;
  readonly pathId: string | undefined;
  readonly arc: ArcSpec | undefined;
  readonly smooth: boolean;
  readonly closed: boolean;
}

/** Path chain from points (polyline or smooth spline, open or closed), a sketch or an arc, or a message. */
function patternPath(
  doc: Parameters<typeof sketchPath>[0],
  { path, pathId, arc, smooth, closed }: PathSource,
): CurveSegment<Vec3>[] | string {
  const given = [path, pathId, arc].filter((source) => source !== undefined).length;
  if (given !== 1) return 'give exactly one of path, pathId or arc';
  if (arc !== undefined) return arcPath(arc);
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

/** Path fraction of copy `k`: even spacing over the trimmed open path, or round the loop from the start offset. */
function fractionOf(
  k: number,
  count: number,
  loop: boolean,
  startFraction: number,
  spanFraction: number,
): number {
  if (loop) return (startFraction + k / count) % 1;
  return startFraction + (count === 1 ? 0 : (spanFraction * k) / (count - 1));
}

/**
 * @command pattern_along_path
 * @pure
 * @layer core/commands
 * @affects creates `count` copies of the source (an entity, or fresh instances of a component) along the path (source untouched)
 * @invariant copy k sits at path fraction k/(count-1) (open) or k/count (closed loop), shifted by
 *   startOffset; when oriented its local +X follows the tangent, +Y the frame normal, +Z the
 *   binormal, then rolls k·rollStep about +X; unoriented copies keep the source rotation
 * @failure missing source/component, bad count, bad / ambiguous path, bad offsets -> no-op, affected:[]
 */
export const patternAlongPath = defineCommand({
  name: 'pattern_along_path',
  description:
    'Lay copies of an entity along a curve: chain links round a chainring and cassette loop, tyre ' +
    'tread blocks round a tyre, sprocket / gear teeth, cable clips, rivets, fence posts, parts fanned ' +
    'on an arc. By default each copy is ORIENTED by the curve: model the source at the world origin ' +
    'in its "along the path" pose: its local +X follows the path tangent, +Y the path normal, +Z the ' +
    'binormal (≈ world up on a horizontal path); copies rotate about their position. orient:false ' +
    'keeps the source rotation instead (plain spacing along a path). rollStep adds an extra roll ' +
    'about the tangent per copy (π/2 alternates chain plates). Source: `sourceId` (an entity to copy) ' +
    'or `componentId` (fresh instances of a component from create_component). Path, give exactly one: ' +
    '`pathId` (a 2D sketch curve: line, arc, polyline, spline, circle, ellipse, rectangle; open or ' +
    'closed), `path` points (straight runs, or smooth: true for a spline; closed: true loops back) ' +
    'or `arc` (centre, normal, radius and angle sweep in radians; a full 2π sweep is a closed loop). ' +
    'Open paths put copies at both ends (a single copy sits at the start); closed loops space count ' +
    'copies evenly all round. startOffset / endOffset trim the open path from both ends (on a closed ' +
    'loop startOffset shifts the pattern). The source entity is kept.',
  params: z.object({
    sourceId: z.string().describe('Id of the entity to copy (2D or 3D).').optional(),
    componentId: z
      .string()
      .describe('Alternative to sourceId: id of a component; each copy is a new instance of it.')
      .optional(),
    count: z.number().int().describe(`Number of copies, 1..${MAX_COPIES_PER_COMMAND}.`),
    pathId: z
      .string()
      .describe('Id of a 2D sketch curve to follow (placed by its own work plane).')
      .optional(),
    path: untypedArray(
      'World [x, y, z] points of the path (>= 2). Alternative to pathId.',
    ).optional(),
    arc: z
      .object({
        center: looseVec3('World-space [x, y, z] centre of the arc.'),
        normal: looseVec3('Normal of the arc plane (non-zero), e.g. [0, 0, 1] for an XY arc.'),
        radius: z.number().describe('Arc radius, > 0.'),
        startAngle: z.number().describe("Sweep start in radians from the plane's local +X axis."),
        endAngle: z.number().describe('Sweep end in radians (counter-clockwise about normal).'),
      })
      .describe('Alternative to pathId / path: a circular arc to follow.')
      .optional(),
    smooth: z
      .boolean()
      .describe('With path points: a smooth spline through them (default: straight runs).')
      .optional(),
    closed: z
      .boolean()
      .describe('With path points: loop back from the last point to the first.')
      .optional(),
    orient: z
      .boolean()
      .describe(
        'Rotate each copy to the path frame (default true); false keeps the source rotation.',
      )
      .optional(),
    rollStep: z
      .number()
      .describe('Extra roll about the tangent added per copy, in radians (default 0).')
      .optional(),
    startOffset: z
      .number()
      .describe(
        'Path length skipped at the start (default 0, >= 0). On a closed loop: pattern shift.',
      )
      .optional(),
    endOffset: z
      .number()
      .describe('Path length skipped at the end (default 0, >= 0). Ignored on closed loops.')
      .optional(),
  }),
  run: (
    doc,
    {
      sourceId,
      componentId,
      count,
      pathId,
      path: rawPath,
      arc,
      smooth = false,
      closed = false,
      orient = true,
      rollStep = 0,
      startOffset = 0,
      endOffset = 0,
    },
  ): CommandResult => {
    const fail = failer(doc, 'pattern_along_path');
    if ((sourceId === undefined) === (componentId === undefined))
      return fail('give exactly one of sourceId or componentId');
    let source: Entity | undefined;
    if (sourceId !== undefined) {
      source = doc.entities[sourceId];
      if (!source) return fail(`source entity "${sourceId}" not found`);
    } else {
      if (componentId === undefined || !Object.hasOwn(doc.components, componentId))
        return fail(`component "${componentId}" not found`);
      source = instanceEntity('template', componentId, ORIGIN, ORIGIN);
    }
    if (count < 1 || count > MAX_COPIES_PER_COMMAND)
      return fail(`count must be in [1, ${MAX_COPIES_PER_COMMAND}] (got ${count})`);
    if (!(startOffset >= 0) || !(endOffset >= 0) || !Number.isFinite(startOffset + endOffset))
      return fail('startOffset and endOffset must be finite and >= 0');
    const path = patternPath(doc, { path: rawPath, pathId, arc, smooth, closed });
    if (typeof path === 'string') return fail(path);
    const loop = isClosedChain(path);
    const issue = chainIssue(path, loop);
    if (issue !== null) return fail(`path invalid — ${issue}`);
    const length = chainLength(path);
    const usable = length - startOffset - endOffset;
    if (!loop && usable <= 1e-12) return fail('offsets leave no usable path length');
    const startFraction = startOffset / length;
    const spanFraction = loop ? 1 : usable / length;
    const baseRotation = source.rotation;
    const placements = Array.from({ length: count }, (_, k) => {
      const { point, normal, binormal } = frameAtFraction(
        path,
        fractionOf(k, count, loop, startFraction, spanFraction),
      );
      if (!orient) return { position: point };
      const tangent = cross3(normal, binormal);
      const roll = rollStep * k;
      const y = add3(scale3(normal, Math.cos(roll)), scale3(binormal, Math.sin(roll)));
      const z = cross3(tangent, y);
      return {
        position: point,
        rotation: composeEulerXYZ(eulerFromAxes(tangent, y, z), baseRotation),
      };
    });
    const { document, newIds } = addCopies(doc, source, placements);
    const what = sourceId ?? `component ${componentId}`;
    return changed(
      document,
      `pattern_along_path: placed ${newIds.length} ${orient ? 'oriented ' : ''}cop${newIds.length === 1 ? 'y' : 'ies'} of "${what}" along a ${loop ? 'closed' : 'open'} path (length ${length.toFixed(3)}).`,
      newIds,
    );
  },
});
