/** Read-only measurements of a sweep for `inspect_sweep` / `check_sweep_loft`: frames, twist, scale, curvature and fold margin at a path fraction. */

import type { SweepEntity, Vec2, Vec3 } from '../../model/types';
import { add3, cross3, dot3, len3, normalize3, scale3 } from '../../lib/vec3';
import { polygonArea } from '../../lib/polygon';
import { baseSectionArea } from './laws';
import { mixTransforms, transformPoint, type SectionTransform } from './sectionTransform';
import { evaluateSweep, type SweepEvaluation } from './evaluate';
import { pathBendAt } from './pathCurvature';
import { orientedFrames, sweepFrames, type SweepFrame } from './frames';
import { sectionLoops, stationLoopAt } from './sections';

/** Measurements at one arc-length fraction (entity-local frame); the curvature is exact (arc, Bézier and ellipse derivatives, the analytic helix). */
export interface SweepSample {
  readonly t: number;
  readonly s: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  readonly twistRad: number;
  readonly scale: number;
  /** Path curvature radius; null on a straight run. */
  readonly curvatureRadius: number | null;
  /** Largest reach of the transformed section toward the centre of curvature (document units); null on a straight run. */
  readonly sectionExtent: number | null;
  /** curvatureRadius / sectionExtent: <= 1 folds the swept envelope onto itself; null when there is no fold risk. */
  readonly margin: number | null;
}

/** Index of the frame span containing fraction `t`, and the blend weight inside it. */
function locate(fractions: readonly number[], t: number): { i: number; u: number } {
  let i = 0;
  while (i < fractions.length - 2 && t > (fractions[i + 1] as number)) i++;
  const span = (fractions[i + 1] ?? 1) - (fractions[i] ?? 0);
  return { i, u: span > 0 ? Math.min(1, Math.max(0, (t - (fractions[i] as number)) / span)) : 0 };
}

const mix3 = (a: Vec3, b: Vec3, u: number): Vec3 => add3(scale3(a, 1 - u), scale3(b, u));

function transformAt(evaluation: SweepEvaluation, i: number, u: number): SectionTransform {
  const a = evaluation.transforms?.[i] ?? { twist: 0, sx: 1, sy: 1 };
  const b = evaluation.transforms?.[Math.min(i + 1, evaluation.frames.length - 1)] ?? a;
  return mixTransforms(a, b, u);
}

/** The section loop at fraction `t`, before the laws. */
function loopAtFraction(sweep: SweepEntity, t: number): Vec2[] {
  return sweep.stations !== undefined && sweep.stations.length >= 2
    ? stationLoopAt(sweep.stations, t, sweep.stationBlend)
    : sectionLoops(sweep.section).outer;
}

/** Measurements of `sweep` at each fraction in `ts`, or the evaluator's refusal. */
export function sweepSamples(
  sweep: SweepEntity,
  ts: readonly number[],
): SweepSample[] | { readonly code: string; readonly message: string } {
  const evaluation = evaluateSweep(sweep);
  if (!('frames' in evaluation)) return evaluation;
  const { frames, fractions, length } = evaluation;
  if (frames.length === 0) return { code: 'SWG_PATH_INVALID', message: 'the path has no samples' };
  const bends = pathBendAt(sweep.path, ts, sweep.helix);
  return ts.map((t, k) => {
    const { i, u } = locate(fractions, t);
    const a = frames[i] as SweepFrame;
    const b = frames[Math.min(i + 1, frames.length - 1)] as SweepFrame;
    const tangent = normalize3(mix3(a.tangent, b.tangent, u));
    const normal = normalize3(mix3(a.normal, b.normal, u));
    const binormal = cross3(tangent, normal);
    const transform = transformAt(evaluation, i, u);
    const bend = bends[k] as Vec3;
    const kappa = len3(bend);
    let curvatureRadius: number | null = null;
    let sectionExtent: number | null = null;
    let margin: number | null = null;
    if (kappa > 1e-12) {
      curvatureRadius = 1 / kappa;
      const toCentre = scale3(bend, 1 / kappa);
      const direction: Vec2 = [dot3(toCentre, normal), dot3(toCentre, binormal)];
      sectionExtent = Math.max(...loopAtFraction(sweep, t).map((p) => dot2(transformPoint(p, transform), direction)));
      margin = sectionExtent > 0 ? curvatureRadius / sectionExtent : null;
    }
    return {
      t,
      s: t * length,
      point: mix3(a.point, b.point, u),
      tangent,
      normal,
      binormal,
      twistRad: transform.twist,
      scale: Math.sqrt(transform.sx * transform.sy),
      curvatureRadius,
      sectionExtent,
      margin,
    };
  });
}

const dot2 = (p: Vec2, q: Vec2): number => p[0] * q[0] + p[1] * q[1];

/** Signed angle about `axis` from `a` to `b`. */
const angleAbout = (a: Vec3, b: Vec3, axis: Vec3): number => Math.atan2(dot3(cross3(a, b), axis), dot3(a, b));

/** Net rotation of the frames `other` relative to `reference` from start to end (radians, accumulated sample to sample). */
function relativeRotation(reference: readonly SweepFrame[], other: readonly SweepFrame[]): number {
  let total = 0;
  let previous = 0;
  for (let i = 0; i < Math.min(reference.length, other.length); i++) {
    const r = reference[i] as SweepFrame;
    const o = other[i] as SweepFrame;
    const angle = angleAbout(r.normal, o.normal, r.tangent);
    if (i > 0) {
      let step = angle - previous;
      step -= 2 * Math.PI * Math.round(step / (2 * Math.PI));
      total += step;
    }
    previous = angle;
  }
  return total;
}

/** ∫ torsion ds of a constant cylindrical helix in closed form: turns × 2π c / √(R² + c²), c = pitch / 2π (negative left-handed); null for any other path. */
function helixFrenetTwist(sweep: SweepEntity): number | null {
  const helix = sweep.helix;
  if (helix === undefined || helix.type !== 'helix' || helix.radius !== helix.endRadius || typeof helix.pitch !== 'number') return null;
  const lead = helix.pitch / (2 * Math.PI);
  return (helix.handedness === 'right' ? 1 : -1) * ((helix.turns * 2 * Math.PI * lead) / Math.hypot(helix.radius, lead));
}

export interface SweepTotals {
  /** Net rotation of the section about the path relative to the twist-free frame: frame mode plus the twist law. */
  readonly twistVsMinimalRad: number;
  /** Net rotation of the Frenet frame relative to the twist-free frame (integral of torsion ds); null when Frenet is undefined. */
  readonly twistVsFrenetRad: number | null;
  /** ∫ A(s) ds of the section area along the path. */
  readonly integralAreaDs: number;
}

/** Aggregates of `sweep`, or the evaluator's refusal. */
export function sweepTotals(sweep: SweepEntity): SweepTotals | { readonly code: string; readonly message: string } {
  const evaluation = evaluateSweep(sweep);
  if (!('frames' in evaluation)) return evaluation;
  const { frames, transforms } = evaluation;
  const minimal = sweepFrames(sweep.path);
  const frenet = orientedFrames(sweep.path, { mode: 'frenet' }, 1);
  const lawTwist =
    transforms === null ? 0 : (transforms[transforms.length - 1] as SectionTransform).twist - (transforms[0] as SectionTransform).twist;
  const baseArea = sweep.stations === undefined ? baseSectionArea(sweep) : null;
  let integral = 0;
  for (let i = 0; i + 1 < frames.length; i++) {
    // the exact path length shared out by the frames' chord fractions: no chord deficit on a curved path
    const ds = ((evaluation.fractions[i + 1] as number) - (evaluation.fractions[i] as number)) * evaluation.length;
    const area = (j: number): number => {
      const transform = transforms?.[j];
      const loop = baseArea === null ? loopAtFraction(sweep, evaluation.fractions[j] as number) : null;
      const raw = loop === null ? (baseArea as number) : polygonArea(loop);
      return raw * (transform === undefined ? 1 : transform.sx * transform.sy);
    };
    integral += (ds * (area(i) + area(i + 1))) / 2;
  }
  return {
    twistVsMinimalRad: (frames.length === minimal.length ? relativeRotation(minimal, frames) : 0) + lawTwist,
    twistVsFrenetRad:
      helixFrenetTwist(sweep) ?? (Array.isArray(frenet) && frenet.length === minimal.length ? relativeRotation(minimal, frenet) : null),
    integralAreaDs: integral,
  };
}
