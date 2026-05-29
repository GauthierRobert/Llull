/**
 * distribute_along_path — place N instances of an existing Component at evenly-spaced
 * positions along a 2D path entity (polyline or spline), with optional tangent alignment.
 *
 * Tangent convention: a tangent of [1, 0] (pointing in the +X direction) maps to
 * rotation [0, 0, 0]. A tangent of [0, 1] (+Y) maps to rotation [0, 0, π/2].
 * In general, rotation[2] = atan2(ty, tx). This is a pure Z-axis rotation; the
 * work-plane normal (+Z) is always the rotation axis.
 *
 * Vertex tangent: at a polyline vertex shared by two segments the OUTGOING segment
 * direction is used (the tangent of the segment beginning at that vertex). This gives
 * a sharp snap-to-new-direction at corners, which is the natural chain-link behaviour.
 * For the very last vertex of an open path the INCOMING segment direction is used.
 *
 * Spline chord approximation: spline through-points are connected by linear chords for
 * arc-length computation and tangent sampling. The resulting placement is an approximation
 * of the true Catmull-Rom curve — acceptable for chain-link spacing where the link pitch
 * is small relative to the curve radius. True Catmull-Rom tessellation is delegated to
 * the viewport (VS1 convention) and is not available in the command layer.
 *
 * Closed path: startOffset rotates the whole pattern around the loop. endOffset is ignored.
 * Open path: instances span [startOffset, totalLength − endOffset].
 *
 * count = 1, open path: the single instance is placed at startOffset (not the midpoint).
 *
 * @layer core/commands
 */

import type { CadDocument, InstanceEntity, Vec2, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { DEFAULT_LAYER_ID } from '../model/types';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// Path math helpers (Vec2 only — all 2D, world-space via entity transform)
// ---------------------------------------------------------------------------

function vec2Add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

function vec2Sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function vec2Length(v: Vec2): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}

function vec2Normalize(v: Vec2): Vec2 {
  const len = vec2Length(v);
  if (len < 1e-12) return [1, 0];
  return [v[0] / len, v[1] / len];
}

function vec2Scale(v: Vec2, s: number): Vec2 {
  return [v[0] * s, v[1] * s];
}

/** Rotate a 2D point by angle (radians) around the origin. */
function rotate2D(p: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/** Transform local-2D point into world-3D using path entity position+rotation. */
function toWorld3D(local: Vec2, entityPos: Vec3, entityRotZ: number): Vec3 {
  const rotated = rotate2D(local, entityRotZ);
  return [rotated[0] + entityPos[0], rotated[1] + entityPos[1], entityPos[2]];
}

/** Rotate a 2D tangent by the entity's Z rotation to get the world tangent. */
function toWorldTangent(localTangent: Vec2, entityRotZ: number): Vec2 {
  return rotate2D(localTangent, entityRotZ);
}

/**
 * Compute cumulative arc lengths for a polyline/chord sequence.
 * Returns an array of length `points.length` where [0] = 0 and
 * [i] = total length from points[0] to points[i].
 */
function cumulativeLengths(points: ReadonlyArray<Vec2>, closed: boolean): number[] {
  const cumul: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const seg = vec2Sub(points[i]!, points[i - 1]!);
    cumul.push(cumul[i - 1]! + vec2Length(seg));
  }
  if (closed && points.length >= 2) {
    const wrapSeg = vec2Sub(points[0]!, points[points.length - 1]!);
    cumul.push(cumul[cumul.length - 1]! + vec2Length(wrapSeg));
  }
  return cumul;
}

/** Total arc length (chord-based). Includes the wrap-back chord when closed. */
function totalArcLength(points: ReadonlyArray<Vec2>, closed: boolean): number {
  const cumul = cumulativeLengths(points, closed);
  return cumul[cumul.length - 1] ?? 0;
}

/**
 * Sample the path at arc-length distance `s` from the start.
 * Returns { point, tangent } both in the LOCAL 2D work plane.
 *
 * For an open path `s` is clamped to [0, totalLength].
 * For a closed path the effective point list is treated as periodic:
 * the wrap-back segment from points[n-1] → points[0] is segment index n.
 *
 * Tangent convention (open path):
 *   - At any interior point, use the outgoing segment direction.
 *   - At the very end (s ≥ totalLength), use the last segment direction.
 * Tangent convention (closed path):
 *   - Use the outgoing segment direction at every sample.
 */
interface PathSample {
  point: Vec2;
  tangent: Vec2; // unit vector
}

function samplePath(
  points: ReadonlyArray<Vec2>,
  closed: boolean,
  s: number,
): PathSample {
  if (points.length < 2) {
    return { point: points[0] ?? [0, 0], tangent: [1, 0] };
  }

  // Build the effective point list (add wrap-back start for closed paths)
  const effectivePoints: ReadonlyArray<Vec2> = closed
    ? [...points, points[0]!]
    : points;

  const cumul = cumulativeLengths(points, closed);
  const total = cumul[cumul.length - 1] ?? 0;

  // Clamp s
  const sClamped = Math.max(0, Math.min(s, total));

  // Find the segment that contains sClamped.
  // "Outgoing segment" convention: when s falls exactly on a vertex (cumul[i] == s)
  // and a next segment exists, use the next (outgoing) segment for the tangent.
  // This gives the natural chain-link snap-to-new-direction at corners.
  // For the very last point of an open path (no outgoing segment), the incoming
  // segment direction is used (handled by the last-segment fallback).
  for (let i = 1; i < effectivePoints.length; i++) {
    const segStart = cumul[i - 1]!;
    const segEnd = cumul[i]!;
    const segLen = segEnd - segStart;

    // Is sClamped within this segment? Use strict < for interior points so that
    // a point exactly at cumul[i] falls through to the NEXT segment (outgoing).
    // The last segment always catches the endpoint.
    const isLastSeg = i === effectivePoints.length - 1;
    if (sClamped < segEnd - 1e-10 || isLastSeg) {
      const t = segLen > 1e-12 ? (sClamped - segStart) / segLen : 0;
      const p0 = effectivePoints[i - 1]!;
      const p1 = effectivePoints[i]!;
      const seg = vec2Sub(p1, p0);
      const point: Vec2 = vec2Add(p0, vec2Scale(seg, Math.max(0, Math.min(1, t))));
      const tangent = vec2Normalize(seg);
      return { point, tangent };
    }
  }

  // Fallback: last point, last segment direction
  const last = effectivePoints[effectivePoints.length - 1]!;
  const secondLast = effectivePoints[effectivePoints.length - 2]!;
  return {
    point: last,
    tangent: vec2Normalize(vec2Sub(last, secondLast)),
  };
}

// ---------------------------------------------------------------------------
// distribute_along_path
// ---------------------------------------------------------------------------

interface DistributeAlongPathParams {
  /** Id of an existing 2D path entity (polyline or spline) to distribute instances along. */
  pathId: string;
  /** Id of an existing Component (from create_component) whose instances will be placed. */
  componentId: string;
  /** Number of instances to create. Must be a positive integer. */
  count: number;
  /**
   * When true (default), each instance is rotated so its local +X axis aligns with the
   * path tangent at its placement point (Z-axis rotation only, in radians: rotation[2] = atan2(ty, tx)).
   * When false, all instances have rotation [0, 0, 0] (no tangent rotation applied).
   */
  tangentAlign?: boolean;
  /**
   * Distance along the path from the start where the first instance (index 0) is placed.
   * For closed paths this shifts the whole pattern around the loop; endOffset is ignored.
   * Default: 0. Must be finite and non-negative.
   */
  startOffset?: number;
  /**
   * Distance back from the end of the path where the last instance (index count-1) is placed.
   * Ignored on closed paths. Default: 0. Must be finite and non-negative.
   */
  endOffset?: number;
  /**
   * Optional name prefix for created instances. Instances are named "<name>_0", "<name>_1", etc.
   * Defaults to the component's name when omitted.
   */
  name?: string;
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
export const distributeAlongPath: CommandDefinition<DistributeAlongPathParams> = {
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
  paramsSchema: {
    type: 'object',
    properties: {
      pathId: {
        type: 'string',
        description: 'Id of an existing polyline or spline entity to distribute instances along. Must have >= 2 points.',
      },
      componentId: {
        type: 'string',
        description: 'Id of an existing Component in doc.components. Obtain one via create_component.',
      },
      count: {
        type: 'number',
        description: 'Number of instances to create. Must be a positive integer (>= 1).',
      },
      tangentAlign: {
        type: 'boolean',
        description:
          'When true (default), each instance is rotated so its local +X axis aligns with the path tangent ' +
          '(rotation[2] = atan2(ty, tx)). When false, all instances have rotation [0, 0, 0].',
      },
      startOffset: {
        type: 'number',
        description:
          'Distance along the path from its start where instance 0 is placed. ' +
          'For closed paths this shifts the whole pattern around the loop; endOffset is ignored. ' +
          'Default: 0. Must be finite and non-negative.',
      },
      endOffset: {
        type: 'number',
        description:
          'Distance back from the path end where the last instance is placed. ' +
          'Ignored on closed paths. Default: 0. Must be finite and non-negative.',
      },
      name: {
        type: 'string',
        description:
          'Optional name prefix for created instances. Instances are named "<name>_0", "<name>_1", etc. ' +
          'Defaults to the component name when omitted.',
      },
    },
    required: ['pathId', 'componentId', 'count'],
  },
  run: (
    doc,
    {
      pathId,
      componentId,
      count,
      tangentAlign = true,
      startOffset = 0,
      endOffset = 0,
      name,
    },
  ): CommandResult => {
    // --- Validate path entity ---
    const pathEntity = doc.entities[pathId];
    if (!pathEntity) {
      return {
        document: doc,
        summary: `distribute_along_path: path entity "${pathId}" not found.`,
        affected: [],
      };
    }
    if (pathEntity.kind !== 'polyline' && pathEntity.kind !== 'spline') {
      return {
        document: doc,
        summary: `distribute_along_path: entity "${pathId}" has kind "${pathEntity.kind}"; must be "polyline" or "spline".`,
        affected: [],
      };
    }

    const pathPoints = pathEntity.points as ReadonlyArray<Vec2>;
    const pathClosed: boolean = pathEntity.closed;

    if (!Array.isArray(pathPoints) || pathPoints.length < 2) {
      return {
        document: doc,
        summary: `distribute_along_path: path "${pathId}" has fewer than 2 points (got ${Array.isArray(pathPoints) ? pathPoints.length : 0}).`,
        affected: [],
      };
    }

    // --- Validate component ---
    const component = doc.components[componentId];
    if (!component) {
      return {
        document: doc,
        summary: `distribute_along_path: component "${componentId}" not found in doc.components.`,
        affected: [],
      };
    }

    // --- Validate count ---
    if (!Number.isFinite(count) || count < 1 || !Number.isInteger(count)) {
      return {
        document: doc,
        summary: `distribute_along_path: count must be a positive integer >= 1 (got ${count}).`,
        affected: [],
      };
    }

    // --- Validate offsets ---
    if (!Number.isFinite(startOffset) || startOffset < 0) {
      return {
        document: doc,
        summary: `distribute_along_path: startOffset must be a finite non-negative number (got ${startOffset}).`,
        affected: [],
      };
    }
    if (!Number.isFinite(endOffset) || endOffset < 0) {
      return {
        document: doc,
        summary: `distribute_along_path: endOffset must be a finite non-negative number (got ${endOffset}).`,
        affected: [],
      };
    }

    // --- Compute arc length ---
    const totalLength = totalArcLength(pathPoints, pathClosed);

    if (!Number.isFinite(totalLength) || totalLength < 1e-12) {
      return {
        document: doc,
        summary: `distribute_along_path: path "${pathId}" has zero or degenerate length.`,
        affected: [],
      };
    }

    // --- Compute placement arc-length positions ---
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
        return {
          document: doc,
          summary:
            `distribute_along_path: usable path length is <= 0 ` +
            `(totalLength=${totalLength.toFixed(4)}, startOffset=${startOffset}, endOffset=${endOffset}).`,
          affected: [],
        };
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

    // --- Extract entity position and Z-rotation ---
    const entityPos: Vec3 = pathEntity.position ?? [0, 0, 0];
    const entityRotZ: number =
      Array.isArray(pathEntity.rotation) && pathEntity.rotation.length >= 3
        ? (pathEntity.rotation[2] as number)
        : 0;

    // --- Create instances ---
    const instanceName = name ?? component.name;
    const createdIds: string[] = [];
    let newDoc: CadDocument = doc;

    for (let i = 0; i < placements.length; i++) {
      const s = placements[i]!;
      const sample = samplePath(pathPoints, pathClosed, s);

      // Convert local 2D point to world 3D position
      const worldPos: Vec3 = toWorld3D(sample.point, entityPos, entityRotZ);

      // Compute rotation
      let instanceRotation: Vec3;
      if (tangentAlign) {
        // World tangent = rotate local tangent by entity's Z rotation
        const worldTangent = toWorldTangent(sample.tangent, entityRotZ);
        const rz = Math.atan2(worldTangent[1], worldTangent[0]);
        instanceRotation = [0, 0, rz];
      } else {
        instanceRotation = [0, 0, 0];
      }

      const instanceId = nextId('instance');
      const instance: InstanceEntity = {
        id: instanceId,
        kind: 'instance',
        componentId,
        position: worldPos,
        rotation: instanceRotation,
        layerId: DEFAULT_LAYER_ID,
        color: '#c8553d',
        name: `${instanceName}_${i}`,
      } as InstanceEntity & { name: string };

      newDoc = {
        ...newDoc,
        entities: { ...newDoc.entities, [instanceId]: instance },
        order: [...newDoc.order, instanceId],
      };
      createdIds.push(instanceId);
    }

    // --- Build factual summary ---
    const spacing =
      count <= 1
        ? 0
        : pathClosed
          ? totalLength / count
          : (totalLength - startOffset - endOffset) / (count - 1);

    const firstId = createdIds[0] ?? '';
    const lastId = createdIds[createdIds.length - 1] ?? '';
    const rangeStr = createdIds.length > 1 ? `${firstId}..${lastId}` : firstId;

    return {
      document: newDoc,
      summary:
        `Distributed ${createdIds.length} instance${createdIds.length === 1 ? '' : 's'} of "${component.name}" ` +
        `along ${pathEntity.kind} "${pathId}" ` +
        `(length=${totalLength.toFixed(2)}, spacing=${spacing.toFixed(4)}). ` +
        `Created: ${rangeStr}.`,
      affected: createdIds,
    };
  },
};
