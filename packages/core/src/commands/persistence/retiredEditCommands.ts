/**
 * Rewrites for retired edit/solid commands: single-entity edits folded into their batch forms, the
 * path/arc distribution family folded into `pattern_along_path`, `make_tube_between` into
 * `add_cylinder`, the three boolean_* commands into `boolean`.
 */

import type { RetiredCommandRewrite } from '../types';
import type { Vec3 } from '../../model/types';
import { distance3, isVec3 } from '../../lib/vec3';

type Params = Record<string, unknown>;

/** `{ name, params }` with the entries of `entries` whose value is defined. */
function call(name: string, entries: Params): ReturnType<RetiredCommandRewrite> {
  return {
    name,
    params: Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)),
  };
}

/** `ids: [id]`; a missing id gives `[]` so the batch command rejects it as the old one did. */
const singleId = (id: unknown): unknown[] => (id === undefined ? [] : [id]);

/** Polyline length of a point list, or null when any point is not a finite triple. */
function polylineLength(path: unknown): number | null {
  if (!Array.isArray(path) || !path.every(isVec3)) return null;
  const points: Vec3[] = path;
  return points.reduce((total, point, i) => total + (i === 0 ? 0 : distance3(point, points[i - 1] ?? point)), 0);
}

export const RETIRED_EDIT_COMMANDS: Readonly<Record<string, RetiredCommandRewrite>> = {
  boolean_union: (params) => ({ name: 'boolean', params: { op: 'union', ...params } }),
  boolean_subtract: (params) => ({ name: 'boolean', params: { op: 'subtract', ...params } }),
  boolean_intersect: (params) => ({ name: 'boolean', params: { op: 'intersect', ...params } }),
  move_entity: ({ id, delta }) => call('move_entities', { ids: singleId(id), delta }),
  delete_entity: ({ id }) => call('delete_entities', { ids: singleId(id) }),
  duplicate_entity: ({ id, offset }) => call('duplicate_entities', { ids: singleId(id), offset }),

  /**
   * Unoriented copies at even arc-length spacing (`orient: false`). A single copy sat at the path
   * midpoint, which `startOffset` of half the length reproduces.
   */
  array_along_path: ({ sourceId, path, count }) => {
    const length = polylineLength(path);
    return call('pattern_along_path', {
      sourceId,
      path,
      count,
      orient: false,
      startOffset: count === 1 && length !== null ? length / 2 : undefined,
    });
  },

  /**
   * Same arc sampling (full turns space count copies evenly, a single copy sits mid-sweep). The
   * copies are now oriented by the arc frame (local +X along the tangent) instead of radially
   * outward and compose with the source rotation: a 90 degree yaw about the normal on a source
   * at rotation [0, 0, 0] relative to the old result.
   */
  distribute_on_arc: ({ sourceId, center, normal, radius, startAngle, endAngle, count }) => {
    const sweep = typeof startAngle === 'number' && typeof endAngle === 'number' ? Math.abs(endAngle - startAngle) : null;
    const half = typeof radius === 'number' && sweep !== null ? (radius * sweep) / 2 : undefined;
    return call('pattern_along_path', {
      sourceId,
      count,
      arc: { center, normal, radius, startAngle, endAngle },
      startOffset: count === 1 ? half : undefined,
    });
  },

  /**
   * Instances of the component along the path entity. At a polyline vertex the heading is now the
   * smoothed frame, not the outgoing leg. Splines follow the smooth curve rather
   * than the chords between their points; instances are no longer named `<name>_<i>`.
   */
  distribute_along_path: ({ pathId, componentId, count, tangentAlign, startOffset, endOffset }) =>
    call('pattern_along_path', {
      componentId,
      pathId,
      count,
      orient: tangentAlign,
      startOffset,
      endOffset,
    }),

  /** A cylinder centred on the midpoint of p1..p2 with its axis along p2 - p1. */
  make_tube_between: ({ p1, p2, radius, color }) => {
    const valid = isVec3(p1) && isVec3(p2);
    return call('add_cylinder', {
      radius,
      height: valid ? distance3(p1, p2) : 0,
      position: valid ? p1.map((v, i) => (v + (p2[i] ?? 0)) / 2) : undefined,
      axis: valid ? p2.map((v, i) => v - (p1[i] ?? 0)) : undefined,
      color,
    });
  },
};
