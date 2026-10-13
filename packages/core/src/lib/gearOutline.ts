/** Pure involute tooth-outline generator shared by spur, internal, planetary and spline commands. */

import { polar as polarAbout } from './arc';
import type { Point2 } from './polygon';

/** Default points per involute flank: ≈ 0.03% radial error against the true curve for standard teeth. */
export const DEFAULT_FLANK_SAMPLES = 7;

/** Backlash added between mating gears, as a fraction of the module (tooth thickness at pitch). */
const BACKLASH_PER_MODULE = 0.05;

/** Pitch-circle radius of a gear of `mod` (module) and `teeth`: module * teeth / 2. */
export function pitchRadiusOf(mod: number, teeth: number): number {
  return (mod * teeth) / 2;
}

/**
 * `samples` points of the involute of a circle of radius `rb` (x = rb(cos t + t sin t),
 * y = rb(sin t - t cos t)), t linear from `tStart` to `tEnd`. Shared by `draw_involute`.
 */
export function sampleInvolute(rb: number, tStart: number, tEnd: number, samples: number): ReadonlyArray<Point2> {
  const n = Math.max(samples - 1, 1);
  return Array.from({ length: n + 1 }, (_, i): Point2 => {
    const t = tStart + ((tEnd - tStart) * i) / n;
    return [rb * (Math.cos(t) + t * Math.sin(t)), rb * (Math.sin(t) - t * Math.cos(t))];
  });
}

/**
 * One tooth-pattern description. The outline carries `teeth` teeth, tooth 0 centred on angle `phase`.
 * Flanks are involutes of `baseRadius`; `halfAngleAtRef` is the half angular thickness of a tooth
 * at `refRadius` (π/(2·teeth) for a standard tooth of thickness πm/2 on the pitch circle).
 */
export interface ToothPattern {
  readonly teeth: number;
  readonly baseRadius: number;
  readonly tipRadius: number;
  readonly rootRadius: number;
  readonly refRadius: number;
  readonly halfAngleAtRef: number;
  /** Points per flank (>= 2). */
  readonly flankSamples: number;
  /** Rotation of the whole outline about the origin, radians. */
  readonly phase: number;
}

/** Involute parameter t (= tan of the pressure angle) at which the curve reaches radius `r`. */
const involuteT = (baseRadius: number, r: number): number => (r <= baseRadius ? 0 : Math.sqrt((r / baseRadius) ** 2 - 1));

/** Smallest half angular thickness at the tip, as a fraction of the nominal half pitch-thickness, before the tip radius is lowered. */
const MIN_TIP_FRACTION = 0.15;
/** Maximum angular step of a circular arc segment (tip and root lands). */
const ARC_STEP = 0.2;

/** Exact boundary piece in the same shape as `CurveSegment<Vec2>` (kept local: lib is a leaf). */
export type ToothSegment =
  | { readonly type: 'line'; readonly points: readonly [Point2, Point2] }
  | { readonly type: 'arc'; readonly points: readonly [Point2, Point2, Point2] }
  | { readonly type: 'bezier'; readonly points: readonly [Point2, Point2, Point2, Point2] };

interface FlankSample {
  readonly radius: number;
  readonly half: number;
  /** Involute parameter t. */
  readonly t: number;
}

function flankSamplesOf(pattern: ToothPattern): {
  flank: FlankSample[];
  undercut: boolean;
  halfAngle: (t: number) => number;
} {
  const { baseRadius, tipRadius, rootRadius, refRadius, halfAngleAtRef } = pattern;
  const samples = Math.max(2, Math.round(pattern.flankSamples));
  const tRef = involuteT(baseRadius, refRadius);
  const halfAtBase = halfAngleAtRef + (tRef - Math.atan(tRef));
  const halfAngle = (t: number): number => halfAtBase - (t - Math.atan(t));
  const undercut = baseRadius >= rootRadius;
  const tStart = undercut ? 0 : involuteT(baseRadius, rootRadius);
  let tEnd = involuteT(baseRadius, tipRadius);
  const minTipHalf = (MIN_TIP_FRACTION * Math.PI) / (2 * pattern.teeth);
  if (halfAngle(tEnd) < minTipHalf) {
    let lo = tStart;
    let hi = tEnd;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (halfAngle(mid) > minTipHalf) lo = mid;
      else hi = mid;
    }
    tEnd = lo;
  }
  const flank = Array.from({ length: samples }, (_, i): FlankSample => {
    const t = tStart + ((tEnd - tStart) * i) / (samples - 1);
    return { radius: baseRadius * Math.sqrt(1 + t * t), half: halfAngle(t), t };
  });
  return { flank, undercut, halfAngle };
}

const polar = (radius: number, angle: number): Point2 => polarAbout([0, 0], radius, angle);

/**
 * Closed CCW tooth outline (first point NOT repeated), tooth 0 centred at `phase`, plus the exact
 * boundary chain (line lead-ins, one cubic Bézier per involute flank, circular tip/root arcs).
 * Per tooth the traversal is: root lead-in → left flank up → tip land → right flank down → root land.
 * @invariant when baseRadius > rootRadius (few teeth) each flank starts with a radial lead-in to the root circle
 * @invariant the tip radius is lowered when the involute would make the tooth pointed
 * @invariant `curves` is a closed chain whose segment end points are all points of `points`
 */
export function toothProfile(pattern: ToothPattern): {
  points: Point2[];
  curves: ToothSegment[];
} {
  const { teeth, baseRadius, rootRadius, phase } = pattern;
  const { flank, undercut } = flankSamplesOf(pattern);
  const first = flank[0]!;
  const last = flank[flank.length - 1]!;
  const pitchAngle = (2 * Math.PI) / teeth;
  const tipSteps = Math.max(2, Math.ceil((2 * last.half) / ARC_STEP));
  const rootSpan = pitchAngle - 2 * first.half;
  const rootSteps = Math.max(2, Math.ceil(rootSpan / ARC_STEP));
  /** Cubic Bézier of the involute between `a` and `b` on the side `sign` (−1 left, +1 right) of tooth `centre`. */
  const flankBezier = (centre: number, sign: 1 | -1, a: FlankSample, b: FlankSample): readonly [Point2, Point2, Point2, Point2] => {
    const point = (f: FlankSample): Point2 => polar(f.radius, centre + sign * f.half);
    const tangent = (f: FlankSample): Point2 => {
      const radial = (baseRadius * f.t) / Math.sqrt(1 + f.t * f.t);
      const angular = (-sign * (f.t * f.t)) / (1 + f.t * f.t);
      const angle = centre + sign * f.half;
      return [
        radial * Math.cos(angle) - f.radius * angular * Math.sin(angle),
        radial * Math.sin(angle) + f.radius * angular * Math.cos(angle),
      ];
    };
    const h = (b.t - a.t) / 3;
    const [pa, pb, ta, tb] = [point(a), point(b), tangent(a), tangent(b)];
    return [pa, [pa[0] + h * ta[0], pa[1] + h * ta[1]], [pb[0] - h * tb[0], pb[1] - h * tb[1]], pb];
  };

  const points: Point2[] = [];
  const curves: ToothSegment[] = [];
  for (let k = 0; k < teeth; k++) {
    const centre = phase + k * pitchAngle;
    const leftLead = polar(rootRadius, centre - first.half);
    const rightLead = polar(rootRadius, centre + first.half);
    if (undercut) points.push(leftLead);
    for (const { radius, half } of flank) points.push(polar(radius, centre - half));
    for (let i = 1; i < tipSteps; i++) {
      points.push(polar(last.radius, centre - last.half + (2 * last.half * i) / tipSteps));
    }
    for (const { radius, half } of [...flank].reverse()) points.push(polar(radius, centre + half));
    if (undercut) points.push(rightLead);
    for (let i = 1; i < rootSteps; i++) {
      points.push(polar(rootRadius, centre + first.half + (rootSpan * i) / rootSteps));
    }

    const leftFoot = polar(first.radius, centre - first.half);
    if (undercut) curves.push({ type: 'line', points: [leftLead, leftFoot] });
    curves.push({ type: 'bezier', points: flankBezier(centre, -1, first, last) });
    curves.push({
      type: 'arc',
      points: [polar(last.radius, centre - last.half), polar(last.radius, centre), polar(last.radius, centre + last.half)],
    });
    curves.push({ type: 'bezier', points: flankBezier(centre, 1, last, first) });
    if (undercut) curves.push({ type: 'line', points: [polar(first.radius, centre + first.half), rightLead] });
    const rootStart = undercut ? rightLead : polar(first.radius, centre + first.half);
    const nextLeft = polar(undercut ? rootRadius : first.radius, centre + pitchAngle - first.half);
    curves.push({
      type: 'arc',
      points: [rootStart, polar(rootRadius, centre + pitchAngle / 2), nextLeft],
    });
  }
  return { points, curves };
}

/** Closed CCW tooth outline only (see `toothProfile`). */
export function toothOutline(pattern: ToothPattern): Point2[] {
  return toothProfile(pattern).points;
}

/** Tip/root radii (as pitch radius + `tip`·m / − `root`·m) and backlash direction of a pattern. */
interface PatternDepths {
  readonly tip: number;
  readonly root: number;
  /** −1 thins the teeth (external gear), +1 widens the spaces (internal ring cavity). */
  readonly backlashSign: -1 | 1;
}

function gearPattern(
  mod: number,
  teeth: number,
  pressureAngle: number,
  flankSamples: number,
  phase: number,
  { tip, root, backlashSign }: PatternDepths,
): ToothPattern {
  const pitchRadius = pitchRadiusOf(mod, teeth);
  return {
    teeth,
    baseRadius: pitchRadius * Math.cos(pressureAngle),
    tipRadius: pitchRadius + tip * mod,
    rootRadius: pitchRadius - root * mod,
    refRadius: pitchRadius,
    halfAngleAtRef: Math.PI / (2 * teeth) + (backlashSign * (BACKLASH_PER_MODULE * mod)) / (4 * pitchRadius),
    flankSamples,
    phase,
  };
}

type PatternArgs = [mod: number, teeth: number, pressureAngle: number, flankSamples: number, phase?: number];

const patternWith =
  (depths: PatternDepths) =>
  (...[mod, teeth, pressureAngle, flankSamples, phase = 0]: PatternArgs): ToothPattern =>
    gearPattern(mod, teeth, pressureAngle, flankSamples, phase, depths);

/** Standard full-depth (addendum m, dedendum 1.25m) external tooth pattern of module `mod`. */
export const externalGearPattern = patternWith({ tip: 1, root: 1.25, backlashSign: -1 });

/**
 * Cavity outline of an internal (ring) gear. The outline is a tooth pattern whose "teeth" are the
 * ring's tooth SPACES: tip = ring root (pitch + 1.25m), root = ring tip (pitch − m), spaces widened
 * by the backlash so an external gear of the same module meshes without interference.
 */
export const internalCavityPattern = patternWith({ tip: 1.25, root: 1, backlashSign: 1 });
