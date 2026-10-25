/**
 * Frames carried along a sweep path. `minimal` is the rotation-minimizing frame by double reflection (Wang et al. 2008): start binormal
 * (section +y) is world +Z projected off the tangent (+Y when the path starts vertical), normal (section +x) = binormal × tangent.
 * `frenet`, `fixed` and `binormal` are the other orientation modes (TECHNICAL_SPEC 5.2); each refuses its degenerate case.
 */

import type { CurveSegment } from '../../model/curve';
import type { Vec3 } from '../../model/types';
import type { SweepOrientation } from '../../model/sweepOrientation';
import { helixSamplesAtFractions } from '../../lib/helix/helix';
import { closestOnSurface, refineOnSurface, surfaceProbe, type SurfaceProjection } from '../../lib/nurbs/closest';
import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import type { HelixDefinition } from '../../lib/helix/types';
import { add3, cross3, dot3, len3, lerp3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { segmentLengths } from '../../lib/polyline';
import { clamp01 } from '../../lib/clamp';
import { chainLength, isClosedChain, minCurvatureRadius, segmentPoint, segmentSteps, segmentTangent } from '../curveSegments';
import { ellipseCurvature, ellipseLengthTo } from '../ellipseSegment';

/** One path sample with its section axes. */
export interface SweepFrame {
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  /** Index of the path segment the sample ends (0 for the start sample). */
  readonly segment: number;
  /** Where section coordinates are measured from when that is not the path point (an axial screw section: the axis point at the path's height). */
  readonly origin?: Vec3;
}

/** A frame mode that cannot be carried along the path; `t` is the arc-length fraction of the first bad sample. */
export interface FrameIssue {
  readonly code: 'SWG_FRAME_DEGENERATE' | 'SWG_SURFACE_TOO_FAR';
  readonly message: string;
  readonly t: number;
}

/** Smallest |tangent · plane normal| a `fixed` section tolerates (sin 5 degrees). */
const FIXED_MIN_SINE = Math.sin((5 * Math.PI) / 180);
/** Smallest |direction × tangent| a `binormal` frame tolerates (sin 1 degree). */
const BINORMAL_MIN_SINE = Math.sin(Math.PI / 180);
/** Tangent change per sample below which a Frenet normal is undefined (straight run). */
const FRENET_MIN_TURN = 1e-9;

/** Section axes at the path start (see the module doc). */
export function sweepStartAxes(tangent: Vec3): { normal: Vec3; binormal: Vec3 } {
  const reference: Vec3 = Math.abs(tangent[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0];
  const binormal = normalize3(sub3(reference, scale3(tangent, dot3(reference, tangent))));
  return { normal: cross3(binormal, tangent), binormal };
}

function reflect(v: Vec3, axis: Vec3, axisSq: number): Vec3 {
  return sub3(v, scale3(axis, (2 / axisSq) * dot3(axis, v)));
}

export interface PathSample {
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly segment: number;
}

/** Path samples (joints not repeated); every segment gets `refine` times its usual step count. */
function pathSamples(path: ReadonlyArray<CurveSegment<Vec3>>, refine: number): PathSample[] {
  const samples: PathSample[] = [];
  path.forEach((segment, index) => {
    const steps = segmentSteps(segment) * refine;
    for (let s = index === 0 ? 0 : 1; s <= steps; s++)
      samples.push({ point: segmentPoint(segment, s / steps), tangent: segmentTangent(segment, s / steps), segment: index });
  });
  return samples;
}

/** Arc-length fraction (0..1) of every frame along the path (chord sums). */
export function frameFractions(frames: readonly SweepFrame[]): number[] {
  const distances = [0];
  for (const length of segmentLengths(frames.map((frame) => frame.point)))
    distances.push((distances[distances.length - 1] as number) + length);
  const total = distances[distances.length - 1] as number;
  return distances.map((d) => (total > 0 ? d / total : 0));
}

/** Rotation-minimizing frames at every path sample (joints not repeated); `refine` multiplies the sampling density. */
export function sweepFrames(path: ReadonlyArray<CurveSegment<Vec3>>, refine = 1): SweepFrame[] {
  const frames = rmfFrames(pathSamples(path, refine));
  return isClosedChain(path) && frames.length > 2 ? closeFrames(frames) : frames;
}

/** Rotation-minimizing frames (double reflection) at the given samples, in order. */
function rmfFrames(samples: readonly PathSample[]): SweepFrame[] {
  const first = samples[0];
  if (first === undefined) return [];
  const frames: SweepFrame[] = [{ ...first, ...sweepStartAxes(first.tangent) }];
  for (let i = 1; i < samples.length; i++) {
    const previous = frames[i - 1] as SweepFrame;
    const { point, tangent, segment } = samples[i] as PathSample;
    const v1 = sub3(point, previous.point);
    const c1 = dot3(v1, v1);
    let normal = previous.normal;
    if (c1 > 1e-24) {
      const reflectedNormal = reflect(previous.normal, v1, c1);
      const v2 = sub3(tangent, reflect(previous.tangent, v1, c1));
      const c2 = dot3(v2, v2);
      normal = c2 > 1e-24 ? reflect(reflectedNormal, v2, c2) : reflectedNormal;
    }
    normal = normalize3(sub3(normal, scale3(tangent, dot3(normal, tangent))));
    frames.push({ point, tangent, normal, binormal: cross3(tangent, normal), segment });
  }
  return frames;
}

/**
 * Frames of a closed path: the duplicated end sample is dropped and the rotation-minimizing frame's holonomy (the twist it gains going once
 * round) is spread linearly along the arc length, so the last frame meets the first without a jump.
 */
function closeFrames(frames: SweepFrame[]): SweepFrame[] {
  const open = frames.slice(0, -1);
  const first = open[0] as SweepFrame;
  const last = frames[frames.length - 1] as SweepFrame;
  const twist = Math.atan2(dot3(cross3(first.normal, last.normal), first.tangent), dot3(first.normal, last.normal));
  const fractions = frameFractions(frames);
  return open.map((frame, i) => {
    const angle = -twist * (fractions[i] as number);
    const normal = add3(scale3(frame.normal, Math.cos(angle)), scale3(cross3(frame.tangent, frame.normal), Math.sin(angle)));
    return { ...frame, normal, binormal: cross3(frame.tangent, normal) };
  });
}

/** Frenet frames: normal toward the centre of curvature, from the tangent change between neighbouring samples. */
function frenetFrames(samples: readonly PathSample[]): SweepFrame[] | FrameIssue {
  const frames: SweepFrame[] = [];
  const fractions = frameFractions(samples.map((sample) => ({ ...sample, normal: sample.tangent, binormal: sample.tangent })));
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as PathSample;
    const before = (samples[Math.max(0, i - 1)] as PathSample).tangent;
    const after = (samples[Math.min(samples.length - 1, i + 1)] as PathSample).tangent;
    const turn = sub3(after, before);
    const previous = frames[i - 1];
    const normal = normalize3(turn);
    if (len3(turn) < FRENET_MIN_TURN || (previous !== undefined && dot3(normal, previous.normal) < 0))
      return {
        code: 'SWG_FRAME_DEGENERATE',
        message: `the Frenet normal is undefined or flips (straight run or inflection) at t=${(fractions[i] as number).toFixed(4)}`,
        t: fractions[i] as number,
      };
    frames.push({ ...sample, normal, binormal: cross3(sample.tangent, normal) });
  }
  return frames;
}

/** Screw frames: the section plane holds the axis and the path point, x = radial unit, y = axis direction. */
function axisPlaneFrames(
  samples: readonly PathSample[],
  orientation: Extract<SweepOrientation, { mode: 'axis_plane' }>,
): SweepFrame[] | FrameIssue {
  const axis = normalize3(orientation.direction);
  const fractions = frameFractions(samples.map((sample) => ({ ...sample, normal: sample.tangent, binormal: sample.tangent })));
  const frames: SweepFrame[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as PathSample;
    const relative = sub3(sample.point, orientation.axisPoint);
    const height = dot3(relative, axis);
    const radial = sub3(relative, scale3(axis, height));
    const radius = len3(radial);
    const radialUnit = radius > 0 ? scale3(radial, 1 / radius) : radial;
    const turning = Math.abs(dot3(sample.tangent, cross3(axis, radialUnit)));
    if (!(radius > 1e-9 && turning >= BINORMAL_MIN_SINE))
      return {
        code: 'SWG_FRAME_DEGENERATE',
        message: `the path ${radius > 1e-9 ? 'runs in the plane through the axis' : 'touches the axis'} at t=${(fractions[i] as number).toFixed(4)}`,
        t: fractions[i] as number,
      };
    const origin = orientation.sectionFrame === 'axial' ? add3(orientation.axisPoint, scale3(axis, height)) : undefined;
    frames.push({ ...sample, normal: radialUnit, binormal: axis, ...(origin === undefined ? {} : { origin }) });
  }
  return frames;
}

/** Surface frames: section y follows the reference sheet's normal at the foot of the path point (projected normal to the tangent), x = y × tangent. */
function surfaceFrames(
  samples: readonly PathSample[],
  orientation: Extract<SweepOrientation, { mode: 'surface' }>,
): SweepFrame[] | FrameIssue {
  const { surface, tolerance } = orientation;
  const probe = surfaceProbe(surface);
  const fractions = frameFractions(samples.map((sample) => ({ ...sample, normal: sample.tangent, binormal: sample.tangent })));
  const frames: SweepFrame[] = [];
  let foot: SurfaceProjection | null = null;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as PathSample;
    let hit: SurfaceProjection =
      foot === null ? closestOnSurface(surface, sample.point, probe) : refineOnSurface(surface, sample.point, foot.u, foot.v);
    if (foot !== null && hit.distance > tolerance) hit = closestOnSurface(surface, sample.point, probe);
    foot = hit;
    if (hit.distance > tolerance)
      return {
        code: 'SWG_SURFACE_TOO_FAR',
        message: `the path is ${hit.distance.toExponential(2)} from the reference surface at t=${(fractions[i] as number).toFixed(4)} (tolerance ${tolerance.toExponential(2)})`,
        t: fractions[i] as number,
      };
    const n = surfaceSample(surface, hit.u, hit.v).normal;
    const lateral = sub3(n, scale3(sample.tangent, dot3(n, sample.tangent)));
    if (len3(lateral) < BINORMAL_MIN_SINE || len3(n) === 0)
      return {
        code: 'SWG_FRAME_DEGENERATE',
        message: `the reference surface normal is along the path (or undefined) at t=${(fractions[i] as number).toFixed(4)}`,
        t: fractions[i] as number,
      };
    const binormal = scale3(normalize3(lateral), orientation.flip === true ? -1 : 1);
    const before = frames[frames.length - 1];
    if (before !== undefined && dot3(binormal, before.binormal) < 0)
      return {
        code: 'SWG_FRAME_DEGENERATE',
        message: `the reference surface normal reverses between samples at t=${(fractions[i] as number).toFixed(4)} (a fold or an unoriented sheet): split the path there`,
        t: fractions[i] as number,
      };
    frames.push({ ...sample, normal: cross3(binormal, sample.tangent), binormal });
  }
  return frames;
}

/** Frames whose section axes are the same for every sample (`fixed`) or follow a reference direction (`binormal`). */
function referenceFrames(
  samples: readonly PathSample[],
  orientation: Extract<SweepOrientation, { mode: 'fixed' | 'binormal' }>,
): SweepFrame[] | FrameIssue {
  const direction = normalize3(orientation.direction ?? [0, 0, 1]);
  const fractions = frameFractions(samples.map((sample) => ({ ...sample, normal: sample.tangent, binormal: sample.tangent })));
  const fixed = orientation.mode === 'fixed';
  const limit = fixed ? FIXED_MIN_SINE : BINORMAL_MIN_SINE;
  const axes = sweepStartAxes(direction);
  const frames: SweepFrame[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as PathSample;
    const sine = fixed ? Math.abs(dot3(sample.tangent, direction)) : len3(cross3(direction, sample.tangent));
    if (!(sine >= limit))
      return {
        code: 'SWG_FRAME_DEGENERATE',
        message: `the path is ${fixed ? 'parallel to the section plane' : 'parallel to the reference direction'} at t=${(fractions[i] as number).toFixed(4)}`,
        t: fractions[i] as number,
      };
    if (fixed) frames.push({ ...sample, ...axes });
    else {
      const normal = normalize3(cross3(direction, sample.tangent));
      frames.push({ ...sample, normal, binormal: cross3(sample.tangent, normal) });
    }
  }
  return frames;
}

/**
 * Frames for an orientation mode (absent = `minimal`), or the reason the mode cannot follow this path.
 * @invariant `minimal` equals `sweepFrames(path, refine)` bit for bit
 * @failure Frenet on a straight run / inflection, `fixed` with the path in the section plane, `binormal` with the path along the direction
 *   -> SWG_FRAME_DEGENERATE
 */
export function orientedFrames(
  path: ReadonlyArray<CurveSegment<Vec3>>,
  orientation: SweepOrientation | undefined,
  refine = 1,
): SweepFrame[] | FrameIssue {
  if (orientation === undefined || orientation.mode === 'minimal') return sweepFrames(path, refine);
  const closed = isClosedChain(path);
  const raw = pathSamples(path, refine);
  const samples = closed && raw.length > 2 ? raw.slice(0, -1) : raw;
  return samplesFrames(samples, orientation);
}

function samplesFrames(
  samples: readonly PathSample[],
  orientation: Exclude<SweepOrientation, { mode: 'minimal' }>,
): SweepFrame[] | FrameIssue {
  if (orientation.mode === 'frenet') return frenetFrames(samples);
  if (orientation.mode === 'surface') return surfaceFrames(samples, orientation);
  return orientation.mode === 'axis_plane' ? axisPlaneFrames(samples, orientation) : referenceFrames(samples, orientation);
}

/** The frames of a loop's samples (first and last sample at the same point) with the rotation-minimizing holonomy spread over the arc length, so the last meets the first. */
function holonomyClosed(frames: SweepFrame[]): SweepFrame[] {
  const first = frames[0] as SweepFrame;
  const last = frames[frames.length - 1] as SweepFrame;
  const twist = Math.atan2(dot3(cross3(first.normal, last.normal), first.tangent), dot3(first.normal, last.normal));
  const fractions = frameFractions(frames);
  return frames.map((frame, i) => {
    const angle = -twist * (fractions[i] as number);
    const normal = add3(scale3(frame.normal, Math.cos(angle)), scale3(cross3(frame.tangent, frame.normal), Math.sin(angle)));
    return { ...frame, normal, binormal: cross3(frame.tangent, normal) };
  });
}

/**
 * Frames of an orientation mode at explicit path samples (the exact-solid stations), or the reason the mode cannot follow them. `closed`: the first
 * and last sample are the same point of a loop and the twist-free frame is closed on itself.
 */
export function framesAtSamples(
  samples: readonly PathSample[],
  orientation: SweepOrientation | undefined,
  closed = false,
): SweepFrame[] | FrameIssue {
  if (orientation === undefined || orientation.mode === 'minimal') return closed ? holonomyClosed(rmfFrames(samples)) : rmfFrames(samples);
  return samplesFrames(samples, orientation);
}

const GAUSS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5688888888888889],
  [-0.5384693101056831, 0.47862867049936647],
  [0.5384693101056831, 0.47862867049936647],
  [-0.906179845938664, 0.23692688505618908],
  [0.906179845938664, 0.23692688505618908],
];

/** Speed |B'(u)| of a cubic Bézier segment. */
function bezierSpeed(p: readonly Vec3[], u: number): number {
  const s = 1 - u;
  const d = (i: number): Vec3 => sub3(p[i + 1] as Vec3, p[i] as Vec3);
  return 3 * len3(add3(add3(scale3(d(0), s * s), scale3(d(1), 2 * s * u)), scale3(d(2), u * u)));
}

/** Arc length of a Bézier segment from parameter 0 to `u` (Gauss-Legendre, 8 pieces per unit parameter at least 1). */
function bezierLengthTo(p: readonly Vec3[], u: number): number {
  const pieces = Math.max(1, Math.ceil(u * 8));
  const h = u / pieces;
  let sum = 0;
  for (let i = 0; i < pieces; i++) for (const [x, w] of GAUSS) sum += w * bezierSpeed(p, (i + 0.5) * h + (x * h) / 2) * (h / 2);
  return sum;
}

/** Smooth arc length of one segment: exact for lines and arcs, Gauss-Legendre for Béziers (so stations vary smoothly along the path). */
function smoothLength(segment: CurveSegment<Vec3>): number {
  return segment.type === 'bezier' ? bezierLengthTo(segment.points, 1) : chainLength([segment]);
}

/** Segment index and segment parameter of each arc-length fraction (lines and arcs exactly, Béziers and ellipses by smooth arc length). */
export function locateOnPath(path: ReadonlyArray<CurveSegment<Vec3>>, fractions: readonly number[]): Array<{ segment: number; u: number }> {
  const lengths = path.map(smoothLength);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return fractions.map((t) => {
    let remaining = Math.min(Math.max(t, 0), 1) * total;
    let index = 0;
    while (index < path.length - 1 && remaining > (lengths[index] as number)) remaining -= lengths[index++] as number;
    const segment = path[index] as CurveSegment<Vec3>;
    return { segment: index, u: segmentParameter(segment, (lengths[index] as number) > 0 ? remaining / (lengths[index] as number) : 0) };
  });
}

/** Exact point and tangent of the path at each arc-length fraction (lines and arcs exactly, Béziers by smooth arc length; an exact `helix` wins over its Bézier chain). */
export function pathSamplesAt(
  path: ReadonlyArray<CurveSegment<Vec3>>,
  fractions: readonly number[],
  helix?: HelixDefinition,
): PathSample[] {
  if (helix !== undefined) return helixSamplesAtFractions(helix, fractions).map((sample) => ({ ...sample, segment: 0 }));
  return locateOnPath(path, fractions).map(({ segment: index, u }) => {
    const segment = path[index] as CurveSegment<Vec3>;
    return { point: segmentPoint(segment, u), tangent: segmentTangent(segment, u), segment: index };
  });
}

/** Segment parameter at arc-length fraction `f` of the segment (identity for lines and arcs; bisection on the smooth length for Béziers). */
function segmentParameter(segment: CurveSegment<Vec3>, f: number): number {
  if (segment.type === 'line' || segment.type === 'arc') return f;
  const lengthTo = (u: number): number =>
    segment.type === 'bezier' ? bezierLengthTo(segment.points, u) : ellipseLengthTo(segment.points, u);
  const target = f * lengthTo(1);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (lengthTo(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Point and section axes at path fraction `t` (0..1), interpolated between sampled frames. */
export function frameAtFraction(path: ReadonlyArray<CurveSegment<Vec3>>, t: number): Pick<SweepFrame, 'point' | 'normal' | 'binormal'> {
  const open = sweepFrames(path);
  // A loop's last span runs back to the first frame (the twist correction makes them meet).
  const frames = isClosedChain(path) && open[0] !== undefined ? [...open, open[0]] : open;
  const fractions = frameFractions(frames);
  let i = 0;
  while (i < frames.length - 2 && t > (fractions[i + 1] as number)) i++;
  const a = frames[i] as SweepFrame;
  const b = (frames[i + 1] ?? a) as SweepFrame;
  const span = (fractions[i + 1] ?? 1) - (fractions[i] ?? 0);
  const u = span > 0 ? clamp01((t - (fractions[i] as number)) / span) : 0;
  const lerp = (p: Vec3, q: Vec3): Vec3 => lerp3(p, q, u);
  const normal = normalize3(lerp(a.normal, b.normal));
  const tangent = normalize3(lerp(a.tangent, b.tangent));
  return { point: lerp(a.point, b.point), normal, binormal: cross3(tangent, normal) };
}

/** Curvature of a segment at its start (`end` false) or end. */
function endCurvature(segment: CurveSegment<Vec3>, end: boolean): number {
  if (segment.type === 'line') return 0;
  if (segment.type === 'arc') return 1 / Math.max(minCurvatureRadius(segment), 1e-300);
  if (segment.type === 'ellipse') return ellipseCurvature(segment.points, end ? 1 : 0);
  const [p0, p1, p2, p3] = segment.points;
  const [d1, d2] = end
    ? [sub3(p3, p2), scale3(add3(sub3(p3, scale3(p2, 2)), p1), 2)]
    : [sub3(p1, p0), scale3(add3(sub3(p2, scale3(p1, 2)), p0), 2)];
  const speed = len3(d1);
  return speed > 1e-12 ? len3(cross3(d1, d2)) / (3 * speed ** 3) : 0;
}

/**
 * Arc-length fractions (inside 0..1) of the joints of a chain where the curvature jumps: the pole paths of a swept section are only continuous
 * in their first derivative there, so a fit must put a station on the joint and fit each side on its own.
 */
export function curvatureBreaks(path: ReadonlyArray<CurveSegment<Vec3>>): number[] {
  const lengths = path.map(smoothLength);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const breaks: number[] = [];
  let walked = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    walked += lengths[i] as number;
    const [before, after] = [endCurvature(path[i] as CurveSegment<Vec3>, true), endCurvature(path[i + 1] as CurveSegment<Vec3>, false)];
    if (Math.abs(before - after) > 1e-6 * Math.max(before, after, 1e-12)) breaks.push(walked / total);
  }
  return breaks;
}
