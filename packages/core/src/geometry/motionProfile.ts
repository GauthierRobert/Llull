/**
 * Time profiles (PHY-23 TR-DRV-18): a sequence of dwell / move / sine / table segments evaluated as value, first and second derivative at any
 * time. Pure and total: a profile that cannot be built is a `ProfileRefusal` with a stable DRV_PROFILE_* code, never an exception.
 * Laws of a `move` (rise h over duration β, x = t/β): cam laws s(x), trapezoid and 7-segment S-curve from (v_max, a_max, jerk) or a duration.
 */

import { pchipEvaluate, pchipSlopes } from '../lib/pchip';
import type { MotionProfile, ProfileQuantity, ProfileSegment } from '../model/drives';

interface ProfileSample {
  readonly value: number;
  readonly velocity: number;
  readonly acceleration: number;
}

export interface ProfileRefusal {
  readonly code: 'DRV_PROFILE_INVALID' | 'DRV_PROFILE_DISCONTINUOUS' | 'DRV_PROFILE_INFEASIBLE';
  readonly error: string;
  /** Shortest feasible duration, s (DRV_PROFILE_INFEASIBLE). */
  readonly shortestDuration?: number;
}

export interface CompiledProfile {
  /** Duration of one pass of the segment list, s. */
  readonly cycle: number;
  /** Total duration with the repeats, s. */
  readonly duration: number;
  /** Start time of every segment of one pass, s. */
  readonly segmentStarts: readonly number[];
  /** Value, derivative and second derivative at time t (s) in the profile's own unit; held at the end value after `duration`. */
  evaluate(t: number): ProfileSample;
}

export const isProfileRefusal = (value: unknown): value is ProfileRefusal => typeof value === 'object' && value !== null && 'code' in value;

const UNIT_SCALES: Readonly<Record<ProfileQuantity, Readonly<Record<string, number>>>> = {
  position: { rad: 1, deg: Math.PI / 180, rev: 2 * Math.PI, m: 1, mm: 1e-3 },
  velocity: { 'rad/s': 1, rpm: (2 * Math.PI) / 60, 'deg/s': Math.PI / 180, 'm/s': 1, 'mm/s': 1e-3 },
  torque: { 'N*m': 1, 'N·m': 1, Nm: 1, 'mN*m': 1e-3, mNm: 1e-3 },
  force: { N: 1, kN: 1e3 },
  voltage: { V: 1, mV: 1e-3 },
  frequency: { Hz: 1 },
};

/** Factor from `unit` to SI for the quantity, or null when the unit is not one of that quantity. */
export function profileUnitScale(quantity: ProfileQuantity, unit: string): number | null {
  const table = UNIT_SCALES[quantity];
  return Object.hasOwn(table, unit) ? (table[unit] ?? null) : null;
}

/** True when a position / velocity unit is angular (rad, deg, rev, rpm, rad/s, deg/s), false when linear. */
export const isAngularUnit = (unit: string): boolean => ['rad', 'deg', 'rev', 'rpm', 'rad/s', 'deg/s'].includes(unit);

type Derivatives = readonly [value: number, velocity: number, acceleration: number];

interface Piece {
  readonly duration: number;
  /** Value, first and second derivative at τ in [0, duration]. */
  at(tau: number): Derivatives;
}

/** Law of a move in normalised time x in [0, 1]: s, ds/dx, d2s/dx2 (s from 0 to 1). */
type Shape = (x: number) => Derivatives;

interface AccelerationPiece {
  readonly length: number;
  readonly acc: (u: number) => number;
  readonly vel: (u: number) => number;
  readonly pos: (u: number) => number;
}

const K_RAMP = 4 * Math.PI;

const sineUp: AccelerationPiece = {
  length: 1 / 8,
  acc: (u) => Math.sin(K_RAMP * u),
  vel: (u) => (1 - Math.cos(K_RAMP * u)) / K_RAMP,
  pos: (u) => u / K_RAMP - Math.sin(K_RAMP * u) / K_RAMP ** 2,
};
const cosineDown: AccelerationPiece = {
  length: 1 / 8,
  acc: (u) => -Math.cos(K_RAMP * u),
  vel: (u) => -Math.sin(K_RAMP * u) / K_RAMP,
  pos: (u) => -(1 - Math.cos(K_RAMP * u)) / K_RAMP ** 2,
};
const plateau = (length: number, sign: number): AccelerationPiece => ({
  length,
  acc: () => sign,
  vel: (u) => sign * u,
  pos: (u) => (sign * u * u) / 2,
});
const cosinePiece = (length: number, k: number): AccelerationPiece => ({
  length,
  acc: (u) => Math.cos(k * u),
  vel: (u) => Math.sin(k * u) / k,
  pos: (u) => (1 - Math.cos(k * u)) / k ** 2,
});

/** Law whose acceleration is piecewise known in closed form: integrated twice, then scaled so that s(1) = 1 (the pieces are antisymmetric, so v(1) = 0). */
function accelerationShape(pieces: readonly AccelerationPiece[]): Shape {
  const starts: { x0: number; v0: number; p0: number; piece: AccelerationPiece }[] = [];
  let [x, v, p] = [0, 0, 0];
  for (const piece of pieces) {
    starts.push({ x0: x, v0: v, p0: p, piece });
    p += v * piece.length + piece.pos(piece.length);
    v += piece.vel(piece.length);
    x += piece.length;
  }
  const scale = 1 / p;
  return (position) => {
    const found = starts.find((entry) => position < entry.x0 + entry.piece.length) ?? starts[starts.length - 1];
    if (found === undefined) return [position, 1, 0];
    const u = Math.min(Math.max(position - found.x0, 0), found.piece.length);
    return [(found.p0 + found.v0 * u + found.piece.pos(u)) * scale, (found.v0 + found.piece.vel(u)) * scale, found.piece.acc(u) * scale];
  };
}

const SHAPES: Readonly<Record<'linear' | 'cycloidal' | 'poly345' | 'harmonic' | 'modified_trapezoid' | 'modified_sine', Shape>> = {
  linear: (x) => [x, 1, 0],
  cycloidal: (x) => [x - Math.sin(2 * Math.PI * x) / (2 * Math.PI), 1 - Math.cos(2 * Math.PI * x), 2 * Math.PI * Math.sin(2 * Math.PI * x)],
  poly345: (x) => [10 * x ** 3 - 15 * x ** 4 + 6 * x ** 5, 30 * x ** 2 - 60 * x ** 3 + 30 * x ** 4, 60 * x - 180 * x ** 2 + 120 * x ** 3],
  harmonic: (x) => [(1 - Math.cos(Math.PI * x)) / 2, (Math.PI / 2) * Math.sin(Math.PI * x), (Math.PI ** 2 / 2) * Math.cos(Math.PI * x)],
  modified_trapezoid: accelerationShape([sineUp, plateau(2 / 8, 1), cosinePiece(2 / 8, K_RAMP), plateau(2 / 8, -1), cosineDown]),
  modified_sine: accelerationShape([sineUp, cosinePiece(6 / 8, (4 * Math.PI) / 3), cosineDown]),
};

const TOLERANCE = 1e-9;

const refuse = (code: ProfileRefusal['code'], error: string, shortestDuration?: number): ProfileRefusal => ({
  code,
  error,
  ...(shortestDuration === undefined ? {} : { shortestDuration }),
});

interface JerkPhase {
  readonly duration: number;
  readonly jerk: number;
  /** Acceleration at the start of the phase when it is imposed (a step); default = continuous. */
  readonly start?: number;
}

/** Rest-to-rest motion of `distance` (signed) made of constant-jerk phases; a trapezoid is constant-acceleration phases with imposed starts. */
function jerkPiece(origin: number, distance: number, phases: readonly JerkPhase[]): Piece {
  const sign = Math.sign(distance);
  const rows: { t0: number; p: number; v: number; a: number; jerk: number; duration: number }[] = [];
  let [t, p, v, a] = [0, origin, 0, 0];
  for (const phase of phases) {
    if (phase.duration <= 0) continue;
    if (phase.start !== undefined) a = sign * phase.start;
    const jerk = sign * phase.jerk;
    rows.push({ t0: t, p, v, a, jerk, duration: phase.duration });
    p += v * phase.duration + (a * phase.duration ** 2) / 2 + (jerk * phase.duration ** 3) / 6;
    v += a * phase.duration + (jerk * phase.duration ** 2) / 2;
    a += jerk * phase.duration;
    t += phase.duration;
  }
  return {
    duration: t,
    at: (tau) => {
      const row = rows.find((entry) => tau < entry.t0 + entry.duration) ?? rows[rows.length - 1];
      if (row === undefined) return [origin, 0, 0];
      const s = Math.min(Math.max(tau - row.t0, 0), row.duration);
      return [
        row.p + row.v * s + (row.a * s * s) / 2 + (row.jerk * s ** 3) / 6,
        row.v + row.a * s + (row.jerk * s * s) / 2,
        row.a + row.jerk * s,
      ];
    },
  };
}

const finitePositive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/** Trapezoid in velocity: (v_max, a_max) with an optional longer duration, or a duration with an acceleration fraction. */
function trapezoidPiece(origin: number, distance: number, move: Extract<ProfileSegment, { kind: 'move' }>): Piece | ProfileRefusal {
  const d = Math.abs(distance);
  const { duration, vmax, amax } = move;
  if (amax !== undefined) {
    if (!finitePositive(amax) || (vmax !== undefined && !finitePositive(vmax)))
      return refuse('DRV_PROFILE_INVALID', 'vmax and amax must be positive');
    if (vmax === undefined && duration === undefined) return refuse('DRV_PROFILE_INVALID', 'a trapezoid with amax needs vmax or duration');
    const limit = vmax ?? Infinity;
    const shortest = d >= limit ** 2 / amax ? d / limit + limit / amax : 2 * Math.sqrt(d / amax);
    if (duration !== undefined && duration < shortest * (1 - TOLERANCE))
      return refuse(
        'DRV_PROFILE_INFEASIBLE',
        `trapezoid needs at least ${shortest.toPrecision(6)} s for this distance, vmax and amax`,
        shortest,
      );
    const total = Math.max(duration ?? shortest, shortest);
    const peak = (amax * (total - Math.sqrt(Math.max(total * total - (4 * d) / amax, 0)))) / 2;
    const ramp = peak / amax;
    return jerkPiece(origin, distance, [
      { duration: ramp, jerk: 0, start: amax },
      { duration: total - 2 * ramp, jerk: 0, start: 0 },
      { duration: ramp, jerk: 0, start: -amax },
    ]);
  }
  if (vmax !== undefined || !finitePositive(duration))
    return refuse('DRV_PROFILE_INVALID', 'a trapezoid needs duration, or vmax with amax');
  const fraction = move.accelFraction ?? 1 / 3;
  if (!(fraction > 0 && fraction <= 0.5)) return refuse('DRV_PROFILE_INVALID', 'accelFraction must be in (0, 0.5]');
  const ramp = fraction * duration;
  const peak = d / (duration * (1 - fraction));
  return jerkPiece(origin, distance, [
    { duration: ramp, jerk: 0, start: peak / ramp },
    { duration: duration - 2 * ramp, jerk: 0, start: 0 },
    { duration: ramp, jerk: 0, start: -peak / ramp },
  ]);
}

/** Jerk time Tj and constant-acceleration time of the acceleration phase of a rest-to-v S-curve under (a, j). */
function accelerationPhase(v: number, a: number, jerk: number): { tj: number; constant: number } {
  return v * jerk >= a * a ? { tj: a / jerk, constant: v / a - a / jerk } : { tj: Math.sqrt(v / jerk), constant: 0 };
}

const accelerationTime = (v: number, a: number, jerk: number): number => {
  const { tj, constant } = accelerationPhase(v, a, jerk);
  return 2 * tj + constant;
};

/** Highest cruise speed an S-curve of `d` can reach under (v, a, jerk) without a cruise phase gap (the cruise may be zero). */
function reachableSpeed(d: number, vmax: number, a: number, jerk: number): number {
  if (d >= vmax * accelerationTime(vmax, a, jerk)) return vmax;
  const withPlateau = (a * (-a / jerk + Math.sqrt((a / jerk) ** 2 + (4 * d) / a))) / 2;
  if (withPlateau * jerk >= a * a) return withPlateau;
  return ((d * Math.sqrt(jerk)) / 2) ** (2 / 3);
}

function sCurvePhases(speed: number, a: number, jerk: number, total: number): JerkPhase[] {
  const { tj, constant } = accelerationPhase(speed, a, jerk);
  const cruise = total - 2 * (2 * tj + constant);
  return [
    { duration: tj, jerk },
    { duration: constant, jerk: 0 },
    { duration: tj, jerk: -jerk },
    { duration: cruise, jerk: 0 },
    { duration: tj, jerk: -jerk },
    { duration: constant, jerk: 0 },
    { duration: tj, jerk },
  ];
}

/** 7-segment S-curve: (v_max, a_max, jerk) with an optional longer duration, or a duration with an acceleration fraction and jerk fraction 1/4. */
function sCurvePiece(origin: number, distance: number, move: Extract<ProfileSegment, { kind: 'move' }>): Piece | ProfileRefusal {
  const d = Math.abs(distance);
  const { duration, vmax, amax, jerk } = move;
  if (amax === undefined && vmax === undefined && jerk === undefined) {
    if (!finitePositive(duration)) return refuse('DRV_PROFILE_INVALID', 's_curve needs duration, or vmax, amax and jerk');
    const fraction = move.accelFraction ?? 1 / 3;
    if (!(fraction > 0 && fraction <= 0.5)) return refuse('DRV_PROFILE_INVALID', 'accelFraction must be in (0, 0.5]');
    const ramp = fraction * duration;
    const jerkTime = ramp / 4;
    const speed = d / (duration - ramp);
    const acceleration = speed / (ramp - jerkTime);
    return jerkPiece(origin, distance, sCurvePhases(speed, acceleration, acceleration / jerkTime, duration));
  }
  if (!finitePositive(vmax) || !finitePositive(amax) || !finitePositive(jerk))
    return refuse('DRV_PROFILE_INVALID', 's_curve with limits needs positive vmax, amax and jerk');
  const reach = reachableSpeed(d, vmax, amax, jerk);
  const shortest = d / reach + accelerationTime(reach, amax, jerk);
  if (duration !== undefined && duration < shortest * (1 - TOLERANCE))
    return refuse(
      'DRV_PROFILE_INFEASIBLE',
      `s_curve needs at least ${shortest.toPrecision(6)} s for this distance, vmax, amax and jerk`,
      shortest,
    );
  let speed = reach;
  const total = Math.max(duration ?? shortest, shortest);
  if (total > shortest * (1 + TOLERANCE)) {
    let [low, high] = [0, reach];
    for (let i = 0; i < 200; i++) {
      speed = (low + high) / 2;
      if (d / speed + accelerationTime(speed, amax, jerk) > total) low = speed;
      else high = speed;
    }
  }
  return jerkPiece(origin, distance, sCurvePhases(speed, amax, jerk, total));
}

type MoveSegment = Extract<ProfileSegment, { kind: 'move' }>;

function movePiece(origin: number, move: MoveSegment): Piece | ProfileRefusal {
  const distance = move.to - origin;
  if (!Number.isFinite(move.to)) return refuse('DRV_PROFILE_INVALID', 'move.to must be finite');
  if (move.duration !== undefined && !finitePositive(move.duration)) return refuse('DRV_PROFILE_INVALID', 'duration must be positive');
  if (Math.abs(distance) < 1e-15) return { duration: move.duration ?? 0, at: () => [origin, 0, 0] };
  if (move.law === 'trapezoid') return trapezoidPiece(origin, distance, move);
  if (move.law === 's_curve') return sCurvePiece(origin, distance, move);
  const duration = move.duration ?? (move.law === 'linear' && finitePositive(move.vmax) ? Math.abs(distance) / move.vmax : undefined);
  if (duration === undefined) return refuse('DRV_PROFILE_INVALID', `${move.law} needs a duration`);
  if (!Object.hasOwn(SHAPES, move.law)) return refuse('DRV_PROFILE_INVALID', `unknown move law '${String(move.law)}'`);
  const shape = SHAPES[move.law as keyof typeof SHAPES];
  return {
    duration,
    at: (tau) => {
      const [s, ds, dds] = shape(Math.min(Math.max(tau / duration, 0), 1));
      return [origin + distance * s, (distance * ds) / duration, (distance * dds) / duration ** 2];
    },
  };
}

const isPoint = (point: unknown): point is readonly [number, number] =>
  Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);

function tablePiece(table: Extract<ProfileSegment, { kind: 'table' }>): Piece | ProfileRefusal {
  if (!Array.isArray(table.points) || !table.points.every(isPoint))
    return refuse('DRV_PROFILE_INVALID', 'table points must be an array of finite [time, value] pairs');
  const times = table.points.map((point) => point[0]);
  const values = table.points.map((point) => point[1]);
  if (table.points.length < 2) return refuse('DRV_PROFILE_INVALID', 'a table needs at least 2 points');
  if (table.points.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1])))
    return refuse('DRV_PROFILE_INVALID', 'table values must be finite');
  if (times[0] !== 0 || times.some((time, i) => i > 0 && time <= (times[i - 1] ?? Infinity)))
    return refuse('DRV_PROFILE_INVALID', 'table times must start at 0 and strictly increase');
  const duration = times[times.length - 1] ?? 0;
  if (table.interpolation === 'monotone_cubic') {
    const slopes = pchipSlopes(times, values);
    return {
      duration,
      at: (tau) => {
        const point = pchipEvaluate(times, values, slopes, tau);
        return [point.value, point.slope, point.curvature];
      },
    };
  }
  return {
    duration,
    at: (tau) => {
      let upper = 1;
      while (upper < times.length - 1 && (times[upper] ?? Infinity) <= tau) upper++;
      const [t0, t1] = [times[upper - 1] ?? 0, times[upper] ?? 1];
      const [y0, y1] = [values[upper - 1] ?? 0, values[upper] ?? 0];
      const slope = (y1 - y0) / (t1 - t0);
      return [y0 + slope * (Math.min(Math.max(tau, t0), t1) - t0), slope, 0];
    },
  };
}

function sinePiece(origin: number, sine: Extract<ProfileSegment, { kind: 'sine' }>): Piece | ProfileRefusal {
  if (!finitePositive(sine.frequencyHz) || !finitePositive(sine.cycles) || !Number.isFinite(sine.amplitude))
    return refuse('DRV_PROFILE_INVALID', 'sine needs a finite amplitude and positive frequencyHz and cycles');
  const w = 2 * Math.PI * sine.frequencyHz;
  const phase = ((sine.phaseDeg ?? 0) * Math.PI) / 180;
  return {
    duration: sine.cycles / sine.frequencyHz,
    at: (tau) => [
      origin + sine.amplitude * (Math.sin(w * tau + phase) - Math.sin(phase)),
      sine.amplitude * w * Math.cos(w * tau + phase),
      -sine.amplitude * w * w * Math.sin(w * tau + phase),
    ],
  };
}

function segmentPiece(origin: number, segment: ProfileSegment): Piece | ProfileRefusal {
  switch (segment?.kind) {
    case 'dwell':
      return finitePositive(segment.duration)
        ? { duration: segment.duration, at: () => [origin, 0, 0] }
        : refuse('DRV_PROFILE_INVALID', 'dwell duration must be positive');
    case 'move':
      return movePiece(origin, segment);
    case 'sine':
      return sinePiece(origin, segment);
    case 'table':
      return tablePiece(segment);
    default:
      return refuse('DRV_PROFILE_INVALID', `unknown segment kind '${String((segment as { kind?: unknown } | null)?.kind)}'`);
  }
}

interface Placed {
  readonly t0: number;
  readonly piece: Piece;
}

/**
 * Build a profile, or say why not.
 * @failure unknown shape, bad numbers -> DRV_PROFILE_INVALID; a jump of the value (or of a position profile's velocity) between segments or at
 *   the repeat seam without `allowStep` -> DRV_PROFILE_DISCONTINUOUS; limits that cannot move the distance in `duration` -> DRV_PROFILE_INFEASIBLE with the shortest duration
 */
export function compileProfile(profile: MotionProfile): CompiledProfile | ProfileRefusal {
  if (!Array.isArray(profile.segments) || profile.segments.length === 0)
    return refuse('DRV_PROFILE_INVALID', 'a profile needs at least one segment');
  const repeat = profile.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100000)
    return refuse('DRV_PROFILE_INVALID', 'repeat must be an integer from 1 to 100000');
  const first = profile.segments[0];
  const tableStart = first?.kind === 'table' && Array.isArray(first.points) && isPoint(first.points[0]) ? first.points[0][1] : 0;
  const start = profile.start ?? tableStart;
  if (!Number.isFinite(start)) return refuse('DRV_PROFILE_INVALID', 'start must be finite');
  const placed: Placed[] = [];
  let [time, value, previous]: [number, number, Derivatives | null] = [0, start, null];
  const checkVelocity = profile.quantity === 'position' && profile.allowStep !== true;
  for (const [index, segment] of profile.segments.entries()) {
    const piece = segmentPiece(value, segment);
    if (isProfileRefusal(piece)) return { ...piece, error: `segment ${index}: ${piece.error}` };
    if (piece.duration <= 0) continue;
    const begin = piece.at(0);
    const scale = Math.max(1, Math.abs(value), Math.abs(begin[0]));
    if (previous !== null && profile.allowStep !== true && Math.abs(begin[0] - previous[0]) > TOLERANCE * scale)
      return refuse(
        'DRV_PROFILE_DISCONTINUOUS',
        `segment ${index} starts at ${begin[0]} but the previous one ended at ${previous[0]} (allowStep accepts a jump)`,
      );
    if (index === 0 && Math.abs(begin[0] - start) > TOLERANCE * scale && profile.allowStep !== true)
      return refuse('DRV_PROFILE_DISCONTINUOUS', `segment 0 starts at ${begin[0]} but start is ${start} (allowStep accepts a jump)`);
    if (
      previous !== null &&
      checkVelocity &&
      Math.abs(begin[1] - previous[1]) > 1e-6 * Math.max(1, Math.abs(begin[1]), Math.abs(previous[1]))
    )
      return refuse(
        'DRV_PROFILE_DISCONTINUOUS',
        `segment ${index} starts at velocity ${begin[1]} but the previous one ended at ${previous[1]} (allowStep accepts a jump)`,
      );
    placed.push({ t0: time, piece });
    previous = piece.at(piece.duration);
    [time, value] = [time + piece.duration, previous[0]];
  }
  const firstPlaced = placed[0];
  if (firstPlaced === undefined || previous === null)
    return refuse('DRV_PROFILE_INVALID', 'a profile needs at least one segment of positive duration');
  if (repeat > 1 && profile.allowStep !== true) {
    const begin = firstPlaced.piece.at(0);
    if (Math.abs(begin[0] - previous[0]) > TOLERANCE * Math.max(1, Math.abs(begin[0])))
      return refuse(
        'DRV_PROFILE_DISCONTINUOUS',
        `repeat: the profile ends at ${previous[0]} but starts at ${begin[0]} (allowStep accepts a jump)`,
      );
    if (checkVelocity && Math.abs(begin[1] - previous[1]) > 1e-6 * Math.max(1, Math.abs(begin[1]), Math.abs(previous[1])))
      return refuse(
        'DRV_PROFILE_DISCONTINUOUS',
        `repeat: the profile ends at velocity ${previous[1]} but starts at ${begin[1]} (allowStep accepts a jump)`,
      );
  }
  const cycle = time;
  const duration = cycle * repeat;
  const finalValue = previous[0];
  return {
    cycle,
    duration,
    segmentStarts: placed.map((entry) => entry.t0),
    evaluate: (t) => {
      if (!(t < duration)) return { value: finalValue, velocity: 0, acceleration: 0 };
      const local = t <= 0 ? 0 : repeat > 1 ? t - Math.floor(t / cycle) * cycle : t;
      let lo = 0;
      let hi = placed.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((placed[mid]?.t0 ?? Infinity) <= local) lo = mid;
        else hi = mid - 1;
      }
      const entry = placed[lo] ?? firstPlaced;
      const [v, d1, d2] = entry.piece.at(local - entry.t0);
      return { value: v, velocity: d1, acceleration: d2 };
    },
  };
}

interface ProfilePeaks {
  readonly value: number;
  readonly velocity: number;
  readonly acceleration: number;
}

/** Largest magnitudes of value, velocity and acceleration over the whole profile (a fine scan of every segment, plus the segment edges). */
export function profilePeaks(profile: CompiledProfile): ProfilePeaks {
  const edges = [...profile.segmentStarts, profile.cycle];
  const perSegment = Math.min(20000, Math.max(2000, Math.floor(40000 / Math.max(1, profile.segmentStarts.length))));
  const peaks = { value: 0, velocity: 0, acceleration: 0 };
  const take = (t: number): void => {
    const sample = profile.evaluate(t);
    peaks.value = Math.max(peaks.value, Math.abs(sample.value));
    peaks.velocity = Math.max(peaks.velocity, Math.abs(sample.velocity));
    peaks.acceleration = Math.max(peaks.acceleration, Math.abs(sample.acceleration));
  };
  for (let k = 0; k < edges.length - 1; k++) {
    const [from, to] = [edges[k] ?? 0, edges[k + 1] ?? 0];
    for (let i = 0; i <= perSegment; i++) take(i === perSegment ? to - 1e-12 * Math.max(1, to) : from + ((to - from) * i) / perSegment);
  }
  return peaks;
}
