/**
 * Compass legs -> points of intersection (02 RTE §5.1): legs from the start port, via points, the straight closing leg to the target port,
 * the collinear merge and the port-direction rule. Pure vector maths in document units.
 * @invariant a leg of length <= eps, or a path with no leg at all, is refused (RTE_ZERO_LEG); consecutive collinear legs are merged
 */

import type { Vec3 } from '@core/model/vectors';
import type { Slope } from '@aec/plant/types';
import { add3, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { slopedLeg, validSlope } from './slope';

export const COMPASS_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
export type Compass = (typeof COMPASS_NAMES)[number];

const COMPASS_VECTORS: Readonly<Record<Compass, Vec3>> = {
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
};

export interface LegInput {
  readonly direction: Compass | Vec3;
  /** Along the direction, document units; may be omitted on the last leg when the path ends at a port. */
  readonly length?: number | undefined;
  /** With `slope`: the horizontal length of the leg (the direction must be horizontal); the leg is then longer by sqrt(1 + s^2) and falls / rises. */
  readonly planLength?: number | undefined;
  readonly slope?: Slope | undefined;
}

export interface PathEnd {
  readonly point: Vec3;
  /** Port direction (toward the pipe); absent for an open end. */
  readonly direction?: Vec3 | undefined;
}

export interface PathLeg {
  readonly index: number;
  /** Compass name when axis-aligned, else the unit vector. */
  readonly direction: Compass | Vec3;
  readonly length: number;
  readonly start: Vec3;
  readonly end: Vec3;
}

export interface PathOk {
  readonly ok: true;
  /** Start, interior points of intersection, end; collinear points merged. */
  readonly points: Vec3[];
  readonly legs: PathLeg[];
  /** The straight leg added to reach the target port (before the collinear merge), or null. */
  readonly closingLeg: { readonly direction: Compass | Vec3; readonly length: number } | null;
  /** Angle between the first leg and the start port direction, degrees (null for an open start). */
  readonly startDeviationDeg: number | null;
  readonly endDeviationDeg: number | null;
  /** Interior points removed because their legs are collinear. */
  readonly merged: number;
  /** Slope declared for each merged leg (null = none). */
  readonly legSlopes: Array<Slope | null>;
}

export interface PathFailure {
  readonly ok: false;
  readonly code: 'RTE_ZERO_LEG' | 'RTE_CLOSING_LEG_IMPOSSIBLE' | 'RTE_PORT_DIRECTION' | 'RTE_SLOPE_INVALID';
  readonly message: string;
  readonly paths: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

const fail = (
  code: PathFailure['code'],
  message: string,
  paths: readonly string[],
  detail: Readonly<Record<string, unknown>> = {},
): PathFailure => ({ ok: false, code, message, paths, detail });

/** Geometric tolerance for coordinates of the given magnitude (02 RTE §5: 1e-6 x max(1, |coordinates|)). */
export const epsilonFor = (...points: readonly Vec3[]): number => 1e-6 * Math.max(1, ...points.flatMap((p) => p.map(Math.abs)));

export const unitVector = (v: Vec3): Vec3 => {
  const length = len3(v);
  return length > 0 ? scale3(v, 1 / length) : [0, 0, 0];
};

/** Compass name of an axis-aligned unit vector, else the vector itself. */
export function directionLabel(u: Vec3): Compass | Vec3 {
  const hit = COMPASS_NAMES.find((name) => {
    const v = COMPASS_VECTORS[name];
    return Math.abs(u[0] - v[0]) < 1e-9 && Math.abs(u[1] - v[1]) < 1e-9 && Math.abs(u[2] - v[2]) < 1e-9;
  });
  return hit ?? u;
}

/** Angle between two unit vectors, degrees. */
export const angleBetweenDeg = (a: Vec3, b: Vec3): number => (Math.acos(Math.max(-1, Math.min(1, dot3(a, b)))) * 180) / Math.PI;

/** Unit vector of a compass name or an arbitrary direction (a zero vector stays zero). */
export const legVector = (direction: Compass | Vec3): Vec3 =>
  typeof direction === 'string' ? COMPASS_VECTORS[direction] : unitVector(direction);

/** Collinear legs merge; the merged leg keeps the first slope declared among its parts. */
function mergeCollinear(
  points: readonly Vec3[],
  slopes: ReadonlyArray<Slope | null>,
): { points: Vec3[]; merged: number; slopes: Array<Slope | null> } {
  const kept: Vec3[] = [points[0] as Vec3];
  const keptSlopes: Array<Slope | null> = [];
  let pending: Slope | null = slopes[0] ?? null;
  for (let i = 1; i < points.length - 1; i++) {
    const before = unitVector(sub3(points[i] as Vec3, kept.at(-1) as Vec3));
    const after = unitVector(sub3(points[i + 1] as Vec3, points[i] as Vec3));
    const straight = len3(cross3(before, after)) < 1e-9 && dot3(before, after) > 0;
    if (straight) pending = pending ?? slopes[i] ?? null;
    else {
      kept.push(points[i] as Vec3);
      keptSlopes.push(pending);
      pending = slopes[i] ?? null;
    }
  }
  kept.push(points.at(-1) as Vec3);
  keptSlopes.push(pending);
  return { points: kept, merged: points.length - kept.length, slopes: keptSlopes };
}

/** The sloped leg `i` of the input, or a failure: a slope needs a horizontal direction and a plan length, and no plain length. */
function slopedInput(leg: LegInput, i: number, direction: Vec3): { length: number; direction: Vec3; slope: Slope } | PathFailure {
  const slope = leg.slope;
  if (slope === undefined) return fail('RTE_SLOPE_INVALID', `leg ${i}: planLength needs a slope`, [`legs.${i}.slope`], { leg: i });
  if (!validSlope(slope))
    return fail(
      'RTE_SLOPE_INVALID',
      `leg ${i}: slope ${slope.value} ${slope.unit} must be > 0 and at most 45 degrees (100 %)`,
      [`legs.${i}.slope`],
      { leg: i },
    );
  if (leg.planLength === undefined || leg.length !== undefined || !(leg.planLength > 0))
    return fail(
      'RTE_SLOPE_INVALID',
      `leg ${i}: a sloped leg takes planLength (> 0, the horizontal length) and no length`,
      [`legs.${i}.planLength`],
      { leg: i },
    );
  if (Math.abs(direction[2]) > 1e-9)
    return fail(
      'RTE_SLOPE_INVALID',
      `leg ${i}: a sloped leg starts from a horizontal direction (this one has a vertical component)`,
      [`legs.${i}.direction`],
      { leg: i },
    );
  const plan = unitVector(direction);
  return { ...slopedLeg(plan, leg.planLength, slope), slope };
}

/** Appends the leg points of `legs` and `via` to `start`; a failure names the offending leg. */
function walk(
  start: Vec3,
  legs: readonly LegInput[],
  via: readonly Vec3[],
  end: PathEnd | undefined,
): { points: Vec3[]; slopes: Array<Slope | null> } | PathFailure {
  const points: Vec3[] = [start];
  const slopes: Array<Slope | null> = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i] as LegInput;
    let direction = legVector(leg.direction);
    if (!(len3(direction) > 0)) return fail('RTE_ZERO_LEG', `leg ${i} has a zero direction vector`, [`legs.${i}.direction`], { leg: i });
    const last = i === legs.length - 1 && via.length === 0;
    let length = leg.length;
    let slope: Slope | null = null;
    if (leg.slope !== undefined || leg.planLength !== undefined) {
      const sloped = slopedInput(leg, i, direction);
      if ('ok' in sloped) return sloped;
      ({ direction, length, slope } = sloped);
    } else if (length === undefined) {
      if (!last || end === undefined)
        return fail(
          'RTE_ZERO_LEG',
          `leg ${i} has no length (only the last leg may omit it, when the path ends at \`to\`)`,
          [`legs.${i}.length`],
          { leg: i },
        );
      const offset = sub3(end.point, points.at(-1) as Vec3);
      length = dot3(offset, direction);
      const sideways = len3(sub3(offset, scale3(direction, length)));
      if (!(length > 0) || sideways > epsilonFor(end.point, offset))
        return fail(
          'RTE_CLOSING_LEG_IMPOSSIBLE',
          `leg ${i} without a length must run straight to the target, but the target is ${offset.map((v) => +v.toFixed(6)).join(', ')} away`,
          [`legs.${i}.direction`],
          { leg: i, offset },
        );
    }
    if (!(length > epsilonFor(start, points.at(-1) as Vec3)))
      return fail('RTE_ZERO_LEG', `leg ${i} has length ${length}: it must be longer than zero`, [`legs.${i}.length`], { leg: i, length });
    points.push(add3(points.at(-1) as Vec3, scale3(direction, length as number)));
    slopes.push(slope);
  }
  for (let i = 0; i < via.length; i++) {
    const point = via[i] as Vec3;
    if (len3(sub3(point, points.at(-1) as Vec3)) <= epsilonFor(point, points.at(-1) as Vec3))
      return fail('RTE_ZERO_LEG', `via point ${i} equals the previous point`, [`via.${i}`], { via: i });
    points.push(point);
    slopes.push(null);
  }
  return { points, slopes };
}

const declared = (slope: Slope | null | undefined): boolean => slope !== null && slope !== undefined;

/** The direction of a leg as a port sees it: a leg with a declared slope leaves / arrives along its plan direction (the slope is intended and reported). */
const legTowardPort = (vector: Vec3, sloped: boolean): Vec3 => unitVector(sloped ? [vector[0], vector[1], 0] : vector);

/** RTE_PORT_DIRECTION when the first segment of `points` leaves `direction` by more than the tolerance, else null. */
function startFailure(points: readonly Vec3[], direction: Vec3, toleranceDeg: number, sloped: boolean): PathFailure | null {
  const deviation = angleBetweenDeg(legTowardPort(sub3(points[1] as Vec3, points[0] as Vec3), sloped), direction);
  return deviation <= toleranceDeg
    ? null
    : fail(
        'RTE_PORT_DIRECTION',
        `the first leg leaves ${deviation.toFixed(4)} deg off the start port direction (tolerance ${toleranceDeg} deg)`,
        ['legs.0.direction'],
        { deviationDeg: deviation, toleranceDeg, portDirection: direction },
      );
}

/**
 * The path a `route_pipe` call describes.
 * @param toleranceDeg port-direction tolerance (the spec's elbow-angle tolerance, or the run override)
 * @failure a slope that is not > 0 and <= 100 %, on a leg that is not horizontal, or without planLength -> RTE_SLOPE_INVALID; no leg, via or end -> RTE_ZERO_LEG; zero / missing leg length -> RTE_ZERO_LEG; target not reachable by one straight leg along its
 *   port axis -> RTE_CLOSING_LEG_IMPOSSIBLE (detail.offset); first / last leg off the port direction by more than toleranceDeg -> RTE_PORT_DIRECTION
 */
export function buildPath(
  start: PathEnd,
  end: PathEnd | undefined,
  legs: readonly LegInput[],
  via: readonly Vec3[],
  toleranceDeg: number,
): PathOk | PathFailure {
  const walked = walk(start.point, legs, via, end);
  if ('ok' in walked) return walked;
  const points = walked.points;
  const slopes = walked.slopes;
  const early =
    start.direction !== undefined && points.length > 1 ? startFailure(points, start.direction, toleranceDeg, declared(slopes[0])) : null;
  if (early !== null) return early;
  let closingLeg: PathOk['closingLeg'] = null;
  if (end !== undefined) {
    const last = points.at(-1) as Vec3;
    const offset = sub3(end.point, last);
    const eps = epsilonFor(last, end.point);
    if (len3(offset) > eps) {
      if (end.direction !== undefined) {
        const along = dot3(offset, scale3(end.direction, -1));
        const sideways = len3(cross3(offset, end.direction));
        if (!(along > 0) || sideways > eps)
          return fail(
            'RTE_CLOSING_LEG_IMPOSSIBLE',
            `the target port is ${offset.map((v) => +v.toFixed(6)).join(', ')} from the last point and not on its axis (the pipe must arrive along ${end.direction.map((v) => +v.toFixed(6)).join(', ')} reversed)`,
            ['to'],
            { offset, portDirection: end.direction },
          );
      }
      closingLeg = { direction: directionLabel(unitVector(offset)), length: len3(offset) };
      points.push(end.point);
      slopes.push(null);
    } else if (points.length === 1) return fail('RTE_ZERO_LEG', 'the start and the end are the same point', ['to']);
  } else if (points.length === 1) return fail('RTE_ZERO_LEG', 'give legs, via points or a target (to)', ['legs']);
  const { points: merged, merged: removed, slopes: legSlopes } = mergeCollinear(points, slopes);
  const pathLegs: PathLeg[] = merged.slice(1).map((end2, index) => {
    const from = merged[index] as Vec3;
    return { index, direction: directionLabel(unitVector(sub3(end2, from))), length: len3(sub3(end2, from)), start: from, end: end2 };
  });
  const first = unitVector(sub3(merged[1] as Vec3, merged[0] as Vec3));
  const lastDirection = unitVector(sub3(merged.at(-1) as Vec3, merged.at(-2) as Vec3));
  const startDeviation = start.direction === undefined ? null : angleBetweenDeg(first, start.direction);
  const endDeviation = end?.direction === undefined ? null : angleBetweenDeg(lastDirection, scale3(end.direction, -1));
  const late =
    startDeviation !== null && start.direction !== undefined
      ? startFailure(merged, start.direction, toleranceDeg, declared(legSlopes[0]))
      : null;
  if (late !== null) return late;
  const arrival =
    end?.direction === undefined
      ? null
      : angleBetweenDeg(
          legTowardPort(sub3(merged.at(-1) as Vec3, merged.at(-2) as Vec3), declared(legSlopes.at(-1))),
          scale3(end.direction, -1),
        );
  if (arrival !== null && arrival > toleranceDeg)
    return fail(
      'RTE_PORT_DIRECTION',
      `the last leg arrives ${arrival.toFixed(4)} deg off the end port axis (tolerance ${toleranceDeg} deg)`,
      ['to'],
      { deviationDeg: arrival, toleranceDeg, portDirection: end?.direction },
    );
  return {
    ok: true,
    points: merged,
    legs: pathLegs,
    closingLeg,
    startDeviationDeg: startDeviation,
    endDeviationDeg: endDeviation,
    merged: removed,
    legSlopes,
  };
}
