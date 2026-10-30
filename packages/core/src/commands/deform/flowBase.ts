/** The base curve of flow_along_curve (01 DEF §17.2): the curve the body is laid out along before it is moved onto the target. */

import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { Vec3 } from '../../model/types';
import { type FrameTable, baseFrameAt, buildBaseTable, maxCurvature, projectOnBase } from '../../geometry/deform/flow';
import { type LocalFrame, toLocal } from '../../geometry/deform/frame';
import { len3, sub3 } from '../../lib/vec3';
import type { Refusal } from './target';

/** A curve (world poles) in the local coordinates of `frame`; an affine map of the poles maps the NURBS (weights are kept). */
export const curveToLocal = (curve: NurbsCurveData, frame: LocalFrame): NurbsCurveData => ({
  ...curve,
  poles: curve.poles.map((pole) => toLocal(frame, pole)),
});

/** Whether the curve is a straight line along the frame axis, running toward +z (the default base: the flow then ignores it). */
function straightOnAxis(curve: NurbsCurveData): { readonly first: number; readonly last: number } | null {
  const poles = curve.poles as ReadonlyArray<Vec3>;
  const scale = Math.max(...poles.map((pole) => len3(pole)), 1);
  const onAxis = poles.every((pole) => Math.abs(pole[0]) <= 1e-9 * scale && Math.abs(pole[1]) <= 1e-9 * scale);
  const rising = poles.every((pole, k) => k === 0 || pole[2] >= (poles[k - 1] as Vec3)[2]);
  const first = (poles[0] as Vec3)[2];
  const last = (poles[poles.length - 1] as Vec3)[2];
  return onAxis && rising && last > first ? { first, last } : null;
}

export interface ResolvedBase {
  /** Table of the base curve; null when the base is the frame axis itself (identical to no base). */
  readonly table: FrameTable | null;
  /** Where the body starts along the base (arc length; along the axis for the axis base) and the base length it covers. */
  readonly z0: number;
  readonly baseLength: number;
  /** The body's own vertices in local coordinates (flat xyz), for the Jacobian pre-check. */
  readonly samples: number[];
  /** Direction of the base frame normal where the body starts (unit, local coordinates), for the target's first normal. */
  readonly normal: Vec3;
}

export interface BaseOptions {
  readonly tolerance: number;
  readonly lateral: number;
  /** The first normal of a rotation-minimising frame along `curve` from the direction `x`. */
  readonly firstNormal: (x: Vec3, curve: NurbsCurveData) => Vec3;
}

/**
 * Resolve a base curve (local coordinates) against the body's world `positions`.
 * @failure zero-length curve -> DEF_CURVE_INVALID; the body starts before or ends after the base -> DEF_BASE_CURVE_SHORT; the body reaching farther
 *   from the base than its radius of curvature -> DEF_FOLDOVER
 */
export function resolveBase(
  curve: NurbsCurveData,
  frame: LocalFrame,
  positions: ReadonlyArray<number>,
  options: BaseOptions,
): ResolvedBase | Refusal {
  const samples: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3)
    samples.push(...toLocal(frame, [positions[i] as number, positions[i + 1] as number, positions[i + 2] as number]));
  const short = (what: string): Refusal => ({ code: 'DEF_BASE_CURVE_SHORT', message: what, paths: ['params.baseCurve'] });
  const slack = Math.max(options.tolerance, 1e-6);
  const straight = straightOnAxis(curve);
  if (straight !== null) {
    let [low, high] = [Infinity, -Infinity];
    for (let i = 2; i < samples.length; i += 3) {
      low = Math.min(low, samples[i] as number);
      high = Math.max(high, samples[i] as number);
    }
    if (low < straight.first - slack || high > straight.last + slack)
      return short(`the base runs from ${straight.first} to ${straight.last} along the axis, the body from ${low} to ${high}`);
    return { table: null, z0: low, baseLength: high - low, samples, normal: [1, 0, 0] };
  }
  const built = buildBaseTable(curve, {
    tolerance: options.tolerance,
    lateral: options.lateral,
    initialNormal: options.firstNormal([1, 0, 0], curve),
  });
  if (typeof built === 'string')
    return { code: 'DEF_CURVE_INVALID', message: 'the base curve has zero length or a zero tangent', paths: ['params.baseCurve'] };
  const reach: Array<{ s: number; distance: number }> = [];
  let [low, high] = [Infinity, -Infinity];
  for (let i = 0; i + 2 < samples.length; i += 3) {
    const q: Vec3 = [samples[i] as number, samples[i + 1] as number, samples[i + 2] as number];
    const s = projectOnBase(built.table, q);
    low = Math.min(low, s);
    high = Math.max(high, s);
    reach.push({ s, distance: len3(sub3(q, baseFrameAt(built.table, s).point)) });
  }
  if (low < -slack || high > built.length + slack)
    return short(`the base is ${built.length} long, the body spans ${low} to ${high} along it`);
  // inside the base's sector no point can be farther than the radius of curvature on the centre side (past the centre the projection leaves the base and is
  // refused above); the guard is the exact-equality case, where the map is singular
  const curvature = maxCurvature(built.table);
  const wide = Math.max(...reach.map((r) => r.distance));
  if (curvature * wide >= 1)
    return {
      code: 'DEF_FOLDOVER',
      message: `the body reaches ${wide} from the base curve, as far as its radius of curvature ${1 / curvature}: use a gentler base curve or a thinner body`,
      paths: ['params.baseCurve'],
    };
  return { table: built.table, z0: low, baseLength: high - low, samples, normal: baseFrameAt(built.table, low).n };
}
