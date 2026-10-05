/**
 * Steel a pipe support bears on: the nearest member below (shoe / guide / anchor) or above
 * (hanger) the pipe, found by plan distance and vertical reach.
 * @layer domain-aec
 * @pure
 */

import type { PipeSupportType } from '@core/model/building';
import type { Vec3 } from '@core/model/types';
import type { SteelBar } from './steelMemberBars';

export interface BearingLimits {
  /** Largest vertical gap between the pipe and its steel, mm. */
  readonly maxReach: number;
  /** Extra plan distance beyond half the member width, mm. */
  readonly planTolerance: number;
}

export interface BearingHit {
  readonly memberId: string;
  /** Vertical gap pipe underside → member top (below) or pipe top → member underside (hanger), mm. */
  readonly gap: number;
  /** Plan distance from the support point to the member axis, mm. */
  readonly planDistance: number;
}

/** A shoe may sink this far into the steel (tolerance of the modelled elevations), mm. */
const PENETRATION = 25;
/** A hanger rod is at least this long, mm. */
const MIN_ROD = 50;
const HORIZONTAL_RATIO = 0.1;
const VERTICAL_RATIO = 0.95;

const isBelow = (type: PipeSupportType): boolean => type !== 'hanger';

function planProjection(
  bar: SteelBar,
  point: Vec3,
): { distance: number; t: number; axisZ: number } {
  const [dx, dy] = [bar.end[0] - bar.start[0], bar.end[1] - bar.start[1]];
  const squared = dx * dx + dy * dy;
  const t =
    squared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point[0] - bar.start[0]) * dx + (point[1] - bar.start[1]) * dy) / squared),
        );
  return {
    distance: Math.hypot(point[0] - (bar.start[0] + dx * t), point[1] - (bar.start[1] + dy * t)),
    t,
    axisZ: bar.start[2] + (bar.end[2] - bar.start[2]) * t,
  };
}

/**
 * Whether `bar` can carry a support of `type` at the pipe centreline point `point` (absolute mm,
 * pipe outside diameter `diameter`); the gap and plan distance when it can, else the reason.
 */
export function bearingOf(
  bar: SteelBar,
  type: PipeSupportType,
  point: Vec3,
  diameter: number,
  limits: BearingLimits,
): BearingHit | string {
  const label = `member ${bar.mark} (${bar.profileName})`;
  const [width, depth] = [bar.profile?.b ?? 0, bar.profile?.h ?? 0];
  const slope = bar.length > 0 ? Math.abs(bar.end[2] - bar.start[2]) / bar.length : 0;
  const underside = point[2] - diameter / 2;
  const top = point[2] + diameter / 2;
  const failure = (reason: string): string => `${label} ${reason}`;
  if (slope >= VERTICAL_RATIO) {
    if (!isBelow(type)) return failure('is a column: a hanger needs steel above the pipe');
    const planDistance = Math.hypot(point[0] - bar.start[0], point[1] - bar.start[1]);
    if (planDistance > Math.max(width, depth) / 2 + limits.planTolerance) {
      return failure(`is ${Math.round(planDistance)} mm from the pipe in plan`);
    }
    const [low, high] = [Math.min(bar.start[2], bar.end[2]), Math.max(bar.start[2], bar.end[2])];
    if (underside >= low - PENETRATION && underside <= high + PENETRATION) {
      return { memberId: bar.id, gap: 0, planDistance };
    }
    const gap = underside - high;
    return gap >= 0 && gap <= limits.maxReach
      ? { memberId: bar.id, gap, planDistance }
      : failure(
          `top is ${Math.round(gap)} mm from the pipe underside (reach ${limits.maxReach} mm)`,
        );
  }
  if (slope > HORIZONTAL_RATIO)
    return failure('is inclined: only horizontal members carry supports');
  const projection = planProjection(bar, point);
  if (projection.distance > width / 2 + limits.planTolerance) {
    return failure(
      `is ${Math.round(projection.distance)} mm from the pipe in plan (half width ${Math.round(width / 2)} + tolerance ${limits.planTolerance} mm)`,
    );
  }
  const gap = isBelow(type)
    ? underside - (projection.axisZ + depth / 2)
    : projection.axisZ - depth / 2 - top;
  const [minimum, side] = isBelow(type) ? [-PENETRATION, 'below'] : [MIN_ROD, 'above'];
  if (gap < minimum || gap > limits.maxReach) {
    return failure(
      `is ${Math.round(gap)} mm ${side} the pipe (needs ${minimum}…${limits.maxReach} mm)`,
    );
  }
  return {
    memberId: bar.id,
    gap: Math.max(0, gap),
    planDistance: projection.distance,
  };
}

/** Steel a riser support (clamp with a bracket) bears on: its bracket length and direction. */
export interface RiserHit extends BearingHit {
  /** Horizontal gap pipe surface → member face, mm (the bracket length). */
  readonly standoff: number;
  /** Plan direction from the pipe toward the member axis, radians. */
  readonly angle: number;
}

/**
 * Whether `bar` can take a clamp at the riser point `point` (absolute mm, pipe outside diameter
 * `diameter`) through a horizontal bracket: a column or a horizontal member whose section reaches the
 * clamp elevation (± `planTolerance`) and whose face is within `maxReach` of the pipe surface.
 * The bracket length and direction when it can, else the reason.
 */
export function riserBearingOf(
  bar: SteelBar,
  point: Vec3,
  diameter: number,
  limits: BearingLimits,
): RiserHit | string {
  const label = `member ${bar.mark} (${bar.profileName})`;
  const [width, depth] = [bar.profile?.b ?? 0, bar.profile?.h ?? 0];
  const slope = bar.length > 0 ? Math.abs(bar.end[2] - bar.start[2]) / bar.length : 0;
  const failure = (reason: string): string => `${label} ${reason}`;
  const column = slope >= VERTICAL_RATIO;
  if (!column && slope > HORIZONTAL_RATIO) {
    return failure('is inclined: only columns and horizontal members take riser brackets');
  }
  const projection = column ? null : planProjection(bar, point);
  const nearest: [number, number] =
    projection === null
      ? [bar.start[0], bar.start[1]]
      : [
          bar.start[0] + (bar.end[0] - bar.start[0]) * projection.t,
          bar.start[1] + (bar.end[1] - bar.start[1]) * projection.t,
        ];
  const planDistance = Math.hypot(point[0] - nearest[0], point[1] - nearest[1]);
  const [low, high] = column
    ? [Math.min(bar.start[2], bar.end[2]), Math.max(bar.start[2], bar.end[2])]
    : [(projection?.axisZ ?? 0) - depth / 2, (projection?.axisZ ?? 0) + depth / 2];
  if (point[2] < low - limits.planTolerance || point[2] > high + limits.planTolerance) {
    return failure(
      `spans z ${Math.round(low)}…${Math.round(high)} mm, not the riser elevation ${Math.round(point[2])} mm`,
    );
  }
  const clearance = planDistance - (column ? Math.max(width, depth) : width) / 2 - diameter / 2;
  if (clearance < -PENETRATION) return failure('would pass through the riser');
  if (clearance > limits.maxReach) {
    return failure(
      `is ${Math.round(clearance)} mm from the pipe surface (reach ${limits.maxReach} mm)`,
    );
  }
  return {
    memberId: bar.id,
    gap: 0,
    planDistance,
    standoff: Math.max(0, clearance),
    angle: Math.atan2(nearest[1] - point[1], nearest[0] - point[0]),
  };
}

/** The member with the shortest bracket (then the nearest in plan) a riser clamp at `point` can use, or null. */
export function findRiserBearingMember(
  bars: ReadonlyArray<SteelBar>,
  point: Vec3,
  diameter: number,
  limits: BearingLimits,
): RiserHit | null {
  let best: RiserHit | null = null;
  for (const bar of bars) {
    if (bar.profile === null) continue;
    const hit = riserBearingOf(bar, point, diameter, limits);
    if (typeof hit === 'string') continue;
    if (best === null || hit.standoff < best.standoff - 1e-6) best = hit;
  }
  return best;
}

/** The nearest bearing member (smallest vertical gap, then plan distance) among `bars`, or null. */
export function findBearingMember(
  bars: ReadonlyArray<SteelBar>,
  type: PipeSupportType,
  point: Vec3,
  diameter: number,
  limits: BearingLimits,
): BearingHit | null {
  let best: BearingHit | null = null;
  for (const bar of bars) {
    if (bar.profile === null) continue;
    const hit = bearingOf(bar, type, point, diameter, limits);
    if (typeof hit === 'string') continue;
    if (
      best === null ||
      hit.gap < best.gap - 1e-6 ||
      (Math.abs(hit.gap - best.gap) <= 1e-6 && hit.planDistance < best.planDistance)
    ) {
      best = hit;
    }
  }
  return best;
}
