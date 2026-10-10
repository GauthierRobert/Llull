/**
 * distribute_along_path: instances of a component at evenly-spaced arc-length positions along a
 * polyline/spline path (splines use their through-point chords). A tangent [1, 0] maps to
 * rotation [0, 0, 0]; rotation[2] = atan2(ty, tx). At a vertex the outgoing segment's tangent is
 * used (the last vertex of an open path uses the incoming one).
 *
 * @layer core/commands
 */

import type { InstanceEntity, Vec2 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { rotatePoint2 } from '../lib/polygon';
import { add2, len2, normalize2, scale2, sub2 } from '../lib/vec2';
import { MAX_COPIES_PER_COMMAND } from './limits';
import { changed, noop, report } from './noop';
import { withEntities } from './entityOps';
import { instanceEntity } from './assemblies';

/** Cumulative chord length at each point; a closed path gets one extra entry for the wrap-back chord. */
function cumulativeLengths(points: ReadonlyArray<Vec2>, closed: boolean): number[] {
  const loop = closed && points.length >= 2 ? [...points, points[0] as Vec2] : points;
  const cumul = [0];
  for (let i = 1; i < loop.length; i++) {
    cumul.push((cumul[i - 1] as number) + len2(sub2(loop[i] as Vec2, loop[i - 1] as Vec2)));
  }
  return cumul;
}

/**
 * Point and unit tangent (local 2D) at arc length `s` (clamped to the path). A position exactly on
 * a vertex belongs to the outgoing segment; the last segment catches the end point.
 */
function samplePath(
  points: ReadonlyArray<Vec2>,
  closed: boolean,
  s: number,
): { point: Vec2; tangent: Vec2 } {
  const loop: ReadonlyArray<Vec2> = closed ? [...points, points[0] as Vec2] : points;
  const cumul = cumulativeLengths(points, closed);
  const clamped = Math.max(0, Math.min(s, cumul[cumul.length - 1] as number));
  let i = 1;
  while (i < loop.length - 1 && clamped >= (cumul[i] as number) - 1e-10) i++;
  const [p0, p1] = [loop[i - 1] as Vec2, loop[i] as Vec2];
  const segStart = cumul[i - 1] as number;
  const segLen = (cumul[i] as number) - segStart;
  const t = segLen > 1e-12 ? (clamped - segStart) / segLen : 0;
  const seg = sub2(p1, p0);
  return {
    point: add2(p0, scale2(seg, Math.max(0, Math.min(1, t)))),
    tangent: normalize2(seg, [1, 0]),
  };
}

/**
 * @command distribute_along_path
 * @pure
 * @layer core/commands
 * @affects creates `count` InstanceEntity entities referencing componentId at evenly-spaced positions along pathId
 * @invariant pathId must be an existing polyline or spline entity with >= 2 points
 * @invariant componentId must exist in doc.components
 * @invariant count >= 1 and must be a finite integer
 * @invariant startOffset and endOffset must be finite and non-negative
 * @invariant usable path length (totalLength - startOffset - endOffset) must be > 0 for open paths
 * @failure pathId missing / wrong kind / < 2 points -> no-op, affected:[]
 * @failure componentId missing -> no-op, affected:[]
 * @failure count < 1, non-finite, or non-integer -> no-op, affected:[]
 * @failure startOffset or endOffset non-finite or negative -> no-op, affected:[]
 * @failure offsets exceed path length (usable <= 0) -> no-op, affected:[]
 */
export const distributeAlongPath = defineCommand({
  name: 'distribute_along_path',
  description:
    'Place count instances of an existing Component at evenly-spaced positions along a 2D path entity (polyline or spline). ' +
    'pathId must be an existing polyline or spline entity with at least 2 points. ' +
    'componentId must exist in doc.components (use create_component to define one). ' +
    'count must be a positive integer (>= 1). ' +
    'tangentAlign (default true) rotates each instance so its local +X aligns with the path tangent at that position (Z rotation = atan2(ty, tx)). ' +
    'startOffset and endOffset (default 0) trim the usable length from both ends; ignored/adapted for closed paths. ' +
    'name (optional) sets a prefix for instance names: "link_0", "link_1", … defaults to the component name. ' +
    'Returns affected: ids of all newly created instance entities in placement order.',
  params: z.object({
    pathId: z
      .string()
      .describe(
        'Id of an existing polyline or spline entity to distribute instances along. Must have >= 2 points.',
      ),
    componentId: z
      .string()
      .describe('Id of an existing Component in doc.components. Obtain one via create_component.'),
    count: z
      .number()
      .int()
      .describe('Number of instances to create. Must be a positive integer (>= 1).'),
    tangentAlign: z
      .boolean()
      .describe(
        'When true (default), each instance is rotated so its local +X axis aligns with the path tangent ' +
          '(rotation[2] = atan2(ty, tx)). When false, all instances have rotation [0, 0, 0].',
      )
      .optional(),
    startOffset: z
      .number()
      .describe(
        'Distance along the path from its start where instance 0 is placed. ' +
          'For closed paths this shifts the whole pattern around the loop; endOffset is ignored. ' +
          'Default: 0. Must be finite and non-negative.',
      )
      .optional(),
    endOffset: z
      .number()
      .describe(
        'Distance back from the path end where the last instance is placed. ' +
          'Ignored on closed paths. Default: 0. Must be finite and non-negative.',
      )
      .optional(),
    name: z
      .string()
      .describe(
        'Optional name prefix for created instances. Instances are named "<name>_0", "<name>_1", etc. ' +
          'Defaults to the component name when omitted.',
      )
      .optional(),
  }),
  run: (
    doc,
    { pathId, componentId, count, tangentAlign = true, startOffset = 0, endOffset = 0, name },
  ): CommandResult => {
    const pathEntity = doc.entities[pathId];
    if (!pathEntity) return noop(doc, `distribute_along_path: path entity "${pathId}" not found.`);
    if (pathEntity.kind !== 'polyline' && pathEntity.kind !== 'spline') {
      return noop(
        doc,
        `distribute_along_path: entity "${pathId}" has kind "${pathEntity.kind}"; must be "polyline" or "spline".`,
      );
    }

    const pathPoints = pathEntity.points as ReadonlyArray<Vec2>;
    const pathClosed = pathEntity.closed;

    if (pathPoints.length < 2) {
      return noop(
        doc,
        `distribute_along_path: path "${pathId}" has fewer than 2 points (got ${pathPoints.length}).`,
      );
    }

    const component = doc.components[componentId];
    if (!component) {
      return noop(
        doc,
        `distribute_along_path: component "${componentId}" not found in doc.components.`,
      );
    }

    if (count < 1 || count > MAX_COPIES_PER_COMMAND) {
      return noop(
        doc,
        `distribute_along_path: count must be an integer in [1, ${MAX_COPIES_PER_COMMAND}] (got ${count}).`,
      );
    }

    if (startOffset < 0) {
      return noop(
        doc,
        `distribute_along_path: startOffset must be a finite non-negative number (got ${startOffset}).`,
      );
    }
    if (endOffset < 0) {
      return noop(
        doc,
        `distribute_along_path: endOffset must be a finite non-negative number (got ${endOffset}).`,
      );
    }

    const cumulative = cumulativeLengths(pathPoints, pathClosed);
    const totalLength = cumulative[cumulative.length - 1] ?? 0;

    if (!Number.isFinite(totalLength) || totalLength < 1e-12)
      return noop(doc, `distribute_along_path: path "${pathId}" has zero or degenerate length.`);

    const placements: number[] = [];

    if (pathClosed) {
      // Closed path: endOffset ignored; startOffset shifts the pattern.
      // s_i = startOffset + i * totalLength / count (wrapped around the loop)
      for (let i = 0; i < count; i++) {
        const s = startOffset + (i * totalLength) / count;
        // Wrap s into [0, totalLength)
        placements.push(((s % totalLength) + totalLength) % totalLength);
      }
    } else {
      // Open path: usable = totalLength - startOffset - endOffset
      const usable = totalLength - startOffset - endOffset;
      if (usable <= 1e-12) {
        return report(
          doc,
          `distribute_along_path: usable path length is <= 0 ` +
            `(totalLength=${totalLength.toFixed(4)}, startOffset=${startOffset}, endOffset=${endOffset}).`,
        );
      }

      if (count === 1) {
        // Single instance: place at startOffset
        placements.push(startOffset);
      } else {
        // s_i = startOffset + i * usable / (count - 1)
        for (let i = 0; i < count; i++) {
          placements.push(startOffset + (i * usable) / (count - 1));
        }
      }
    }

    const entityPos = pathEntity.position;
    const entityRotZ = pathEntity.rotation[2];

    const instanceName = name ?? component.name;
    const createdIds: string[] = [];
    const created: InstanceEntity[] = [];

    for (const [i, s] of placements.entries()) {
      const { point, tangent } = samplePath(pathPoints, pathClosed, s);
      const [x, y] = rotatePoint2(point, entityRotZ);
      const [tx, ty] = rotatePoint2(tangent, entityRotZ);
      const instanceId = nextId('instance');
      const instance: InstanceEntity = {
        ...instanceEntity(
          instanceId,
          componentId,
          [x + entityPos[0], y + entityPos[1], entityPos[2]],
          [0, 0, tangentAlign ? Math.atan2(ty, tx) : 0],
        ),
        name: `${instanceName}_${i}`,
      };
      created.push(instance);
      createdIds.push(instanceId);
    }

    const spacing =
      count <= 1
        ? 0
        : pathClosed
          ? totalLength / count
          : (totalLength - startOffset - endOffset) / (count - 1);

    const firstId = createdIds[0] ?? '';
    const lastId = createdIds[createdIds.length - 1] ?? '';
    const rangeStr = createdIds.length > 1 ? `${firstId}..${lastId}` : firstId;

    return changed(
      withEntities(doc, created),
      `Distributed ${createdIds.length} instance${createdIds.length === 1 ? '' : 's'} of "${component.name}" ` +
        `along ${pathEntity.kind} "${pathId}" ` +
        `(length=${totalLength.toFixed(2)}, spacing=${spacing.toFixed(4)}). ` +
        `Created: ${rangeStr}.`,
      createdIds,
    );
  },
});
