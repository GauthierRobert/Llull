/**
 * The advanced loft builder (SWG M5/M7, D-SWG-2): sections wound, seam-aligned, optionally coupled into segments and/or generated along a
 * centreline, then skinned in TypeScript (ruled, smooth, with end derivatives, closed, or as a Gordon surface through guides). The result is one
 * exact NURBS face per segment; the exact kernel sews them and caps the free section boundaries.
 */

import type { Vec3 } from '../../model/vectors';
import { dot3, len3, normalize3, sub3 } from '../../lib/vec3';
import { closestOnSurface, surfaceProbe } from '../../lib/nurbs/closest';
import { insertKnot } from '../../lib/nurbs/edit';
import { evaluateCurve, curveDomain } from '../../lib/nurbs/evaluate';
import { gordonSurface } from '../../lib/nurbs/gordon';
import { skinWithEnds, wireCentroid, type EndData } from '../../lib/nurbs/skinEnds';
import { averagedParameters, compatibleCurves, skinCurves } from '../../lib/nurbs/surfaceFit';
import { extractSubSurface, normalizeKnots } from '../../lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { isClosedCurve } from '../../lib/nurbs/reseam';
import { closureJump } from './closure';
import { coupleSections } from './coupling';
import { achievedAngle, endData, type EndContext } from './ends';
import { alignSections, centrelineSections, sectionNormal, seamTwist, windSections } from './sections';
import type { EndRequest, LoftBuilt, LoftIssue, LoftOptions, LoftReport } from './types';

const MAX_REFINEMENTS = 3;

const lift = (curve: NurbsCurveData): NurbsCurveData => ({ ...curve, weights: curve.poles.map(() => 1) });

/** The sections on one basis; a rational / non-rational mix gets unit weights on the non-rational ones. */
function compatible(curves: readonly NurbsCurveData[]): NurbsCurveData[] | LoftIssue {
  const rational = curves.some((curve) => curve.weights !== undefined);
  const made = compatibleCurves(rational ? curves.map((curve) => (curve.weights === undefined ? lift(curve) : curve)) : curves);
  return typeof made === 'string' ? { code: 'SRF_NURBS_INVALID', message: made } : made;
}

/** Periodic skin through the sections: cyclically extended, interpolated, then the range from the first section to its repeat is cut out. */
function closedSkin(curves: readonly NurbsCurveData[], degreeV: number): NurbsSurfaceData | LoftIssue {
  const count = curves.length;
  const extra = Math.min(6, 2 * count);
  const sequence: NurbsCurveData[] = [];
  for (let i = -extra; i <= count + extra; i++) sequence.push(curves[((i % count) + count) % count] as NurbsCurveData);
  const skin = skinCurves(sequence, degreeV);
  if ('code' in skin) return { code: 'SRF_NURBS_INVALID', message: skin.message };
  const t = averagedParameters(
    (sequence[0] as NurbsCurveData).poles.map((_, i) => sequence.map((curve) => curve.poles[i] as Vec3)),
    sequence.length,
  );
  const cut = extractSubSurface(skin, [0, 1], [t[extra] as number, t[extra + count] as number]);
  return typeof cut === 'string' ? { code: 'SRF_NURBS_INVALID', message: cut } : normalizeKnots(cut);
}

/** Every curve with a knot inserted in the middle of each of its spans (all curves share the knots, so they stay compatible). */
function refine(curves: readonly NurbsCurveData[]): NurbsCurveData[] {
  const knots = (curves[0] as NurbsCurveData).knots;
  return curves.map((curve) => {
    let out: NurbsCurveData | string = curve;
    for (let i = 0; i + 1 < knots.length && typeof out !== 'string'; i++)
      out = insertKnot(out, ((knots[i] as number) + (knots[i + 1] as number)) / 2, 1);
    return typeof out === 'string' ? curve : out;
  });
}

interface SegmentResult {
  readonly surface: NurbsSurfaceData;
  readonly startAngle: number | null;
  readonly endAngle: number | null;
}

/** The apex points of a pointed loft (null = no point end). */
interface Apex {
  readonly start: Vec3 | null;
  readonly end: Vec3 | null;
}

/** Collapses the section `curve` to the single point `at` (same basis). */
const collapse = (curve: NurbsCurveData, at: Vec3): NurbsCurveData => ({ ...curve, poles: curve.poles.map(() => at) });

/** Skins one segment (the corresponding pieces of every section). */
function skinSegment(
  pieces: readonly NurbsCurveData[],
  options: LoftOptions,
  contexts: { start: EndContext | null; end: EndContext | null },
  requests: { start: Exclude<EndRequest, { type: 'point' }> | null; end: Exclude<EndRequest, { type: 'point' }> | null },
  common: readonly number[] | undefined,
  apex: Apex,
): SegmentResult | LoftIssue {
  const made = compatible(pieces);
  if (!Array.isArray(made)) return made;
  // a point end adds one more row collapsed to the apex: every given section is kept
  let curves = [
    ...(apex.start === null ? [] : [collapse(made[0] as NurbsCurveData, apex.start)]),
    ...made,
    ...(apex.end === null ? [] : [collapse(made[made.length - 1] as NurbsCurveData, apex.end)]),
  ];
  const count = curves.length;
  if (options.closed) {
    const surface = closedSkin(curves, options.ruled ? 1 : 3);
    return 'code' in surface ? surface : { surface, startAngle: null, endAngle: null };
  }
  if (requests.start === null && requests.end === null) {
    const surface = skinCurves(curves, options.ruled ? 1 : Math.min(3, count - 1), common);
    return 'code' in surface ? { code: 'SRF_NURBS_INVALID', message: surface.message } : { surface, startAngle: null, endAngle: null };
  }
  if (options.ruled) return { code: 'SWG_LOFT_END_CONDITION_INVALID', message: 'end conditions need a smooth loft (ruled: false)' };
  let result: SegmentResult | LoftIssue = { code: 'SRF_NURBS_INVALID', message: 'no skin' };
  for (let level = 0; level <= MAX_REFINEMENTS; level++) {
    const ends: { start: EndData | undefined; end: EndData | undefined } = { start: undefined, end: undefined };
    for (const which of ['start', 'end'] as const) {
      const request = requests[which];
      const context = contexts[which];
      if (request === null || context === null) continue;
      const data = endData(request, which === 'start' ? (curves[0] as NurbsCurveData) : (curves[count - 1] as NurbsCurveData), context);
      if ('code' in data) return data;
      ends[which] = data;
    }
    const skin = skinWithEnds(curves, ends.start, ends.end, 3, common);
    if ('code' in skin) return { code: 'SWG_LOFT_END_CONDITION_INVALID', message: skin.message };
    const startAngle =
      requests.start === null || contexts.start === null ? null : achievedAngle(skin.surface, 'start', requests.start, contexts.start);
    const endAngle = requests.end === null || contexts.end === null ? null : achievedAngle(skin.surface, 'end', requests.end, contexts.end);
    result = { surface: skin.surface, startAngle, endAngle };
    const worst = Math.max(startAngle ?? 0, endAngle ?? 0);
    if (worst <= options.endAngleTolerance || level === MAX_REFINEMENTS) break;
    curves = refine(curves);
  }
  return result;
}

/** Chord-length parameters 0..1 of the section centroids: one v parametrisation shared by every face of a coupled loft. */
function centroidParameters(sections: readonly NurbsCurveData[], apex: Apex): number[] {
  const centroids = [...(apex.start === null ? [] : [apex.start]), ...sections.map(wireCentroid), ...(apex.end === null ? [] : [apex.end])];
  const steps = centroids.slice(1).map((c, i) => len3(sub3(c, centroids[i] as Vec3)));
  const total = steps.reduce((sum, step) => sum + step, 0);
  const t = [0];
  for (const step of steps) t.push((t[t.length - 1] as number) + step / total);
  t[t.length - 1] = 1;
  return t;
}

/** Largest distance from sample points of the final sections to the faces. */
function sectionDeviation(faces: readonly NurbsSurfaceData[], sections: readonly NurbsCurveData[]): number {
  const probes = faces.map(surfaceProbe);
  let worst = 0;
  for (const section of sections) {
    const [a, b] = curveDomain(section);
    for (let s = 0; s <= 24; s++) {
      const point = evaluateCurve(section, a + ((b - a) * s) / 24);
      worst = Math.max(worst, Math.min(...faces.map((face, i) => closestOnSurface(face, point, probes[i]).distance)));
    }
  }
  return worst;
}

/** End contexts of the final sections: plane normal oriented along the travel, centroid, travel direction. */
function endContexts(sections: readonly NurbsCurveData[], faceTolerance: number): { start: EndContext; end: EndContext } {
  const count = sections.length;
  const centroid = (i: number): Vec3 => wireCentroid(sections[i] as NurbsCurveData);
  const make = (i: number, from: number, to: number): EndContext => {
    const travel = normalize3(sub3(centroid(to), centroid(from)));
    const raw = sectionNormal(sections[i] as NurbsCurveData);
    return { normal: dot3(raw, travel) >= 0 ? raw : [-raw[0], -raw[1], -raw[2]], centroid: centroid(i), travel, faceTolerance };
  };
  return { start: make(0, 0, 1), end: make(count - 1, count - 2, count - 1) };
}

const endRequest = (request: EndRequest | undefined): Exclude<EndRequest, { type: 'point' }> | null =>
  request === undefined || request.type === 'point' ? null : request;

/**
 * The faces of a loft through `input` sections (world curves).
 * @invariant the sections are reproduced (section deviation reported); with guides the faces contain the guides (Gordon); ends reproduce the requested directions within `endAngleTolerance` after up to 3 refinements
 * @failure < 2 sections, closed with < 3 -> SRF_LOFT_SECTIONS_TOO_FEW / SWG_LOFT_CLOSED_TOO_FEW; open sections of a solid -> SWG_SECTION_INVALID; unsupported combinations -> SWG_PARAM_INVALID; the coded refusals of ends, coupling, centreline and guides
 */
export function buildLoft(input: readonly NurbsCurveData[], options: LoftOptions): LoftBuilt | LoftIssue {
  if (input.length < 2) return { code: 'SRF_LOFT_SECTIONS_TOO_FEW', message: `a loft needs at least 2 sections (got ${input.length})` };
  if (options.closed && input.length < 3) return { code: 'SWG_LOFT_CLOSED_TOO_FEW', message: 'a closed loft needs at least 3 sections' };
  if (options.solid) {
    const open = input.findIndex((curve) => !isClosedCurve(curve));
    if (open >= 0)
      return { code: 'SWG_SECTION_INVALID', message: `section ${open} is not a closed curve (first pole = last pole)`, section: open };
  }
  if (options.seams !== undefined) {
    if (options.seams.length !== input.length)
      return { code: 'SWG_PARAM_INVALID', message: `seams needs one fraction per section (${input.length}), got ${options.seams.length}` };
    const bad = options.seams.findIndex((fraction) => !(fraction >= 0 && fraction < 1));
    if (bad >= 0) return { code: 'SWG_PARAM_INVALID', message: `seams[${bad}] = ${options.seams[bad]} must be in [0, 1)`, section: bad };
  }
  const conditioned = options.start !== undefined || options.end !== undefined;
  const guided = (options.guides?.length ?? 0) > 0;
  if (guided && (conditioned || options.closed || options.coupling !== undefined || options.centerline !== undefined))
    return { code: 'SWG_PARAM_INVALID', message: 'guides cannot be combined with end conditions, closed, coupling or a centreline' };
  if (options.centerline !== undefined && (input.length !== 2 || options.coupling !== undefined || options.closed))
    return { code: 'SWG_PARAM_INVALID', message: 'a centreline loft takes exactly 2 sections, not closed and not coupled' };
  if (options.closed && (conditioned || options.coupling !== undefined || options.ruled))
    return { code: 'SWG_PARAM_INVALID', message: 'a closed loft is smooth and takes no end conditions or coupling' };
  let sections: NurbsCurveData[] = options.solid ? windSections(input) : [...input];
  if (options.alignment !== 'none') {
    const aligned = alignSections(sections, options.alignment, options.seams, options.closed);
    if (!Array.isArray(aligned)) return aligned;
    sections = aligned;
  }
  if (options.centerline !== undefined) {
    const made = compatible(sections);
    if (!Array.isArray(made)) return made;
    const placed = centrelineSections(made[0] as NurbsCurveData, made[1] as NurbsCurveData, options.centerline, options.sectionCount ?? 8);
    if (!Array.isArray(placed)) return placed;
    sections = placed;
  }
  const seamTwistMaxRad = options.solid ? seamTwist(sections, options.closed) : 0;
  const contexts = endContexts(sections, options.faceTolerance);
  const base = { seamTwistMaxRad, guideDeviation: null as number | null };
  if (guided) {
    const made = compatible(sections);
    if (!Array.isArray(made)) return made;
    const gordon = gordonSurface(made, options.guides as readonly NurbsCurveData[], options.guideTolerance);
    if ('code' in gordon)
      return { code: gordon.code, message: gordon.message, ...(gordon.section === undefined ? {} : { section: gordon.section }) };
    const report: LoftReport = {
      sectionDeviation: gordon.deviation,
      startAngleRad: null,
      endAngleRad: null,
      faceCount: 1,
      fitDeviation: 0,
      seamTwistMaxRad: base.seamTwistMaxRad,
      guideDeviation: gordon.guideDeviation,
      closureJumpRad: null,
    };
    return { faces: [gordon.surface], sections: made, report };
  }
  const coupled = coupleSections(sections, options);
  if ('code' in coupled) return coupled;
  const apex: Apex = {
    start: options.start?.type === 'point' ? options.start.at : null,
    end: options.end?.type === 'point' ? options.end.at : null,
  };
  const common = coupled.segments.length > 1 ? centroidParameters(sections, apex) : undefined;
  const faces: NurbsSurfaceData[] = [];
  let startAngle: number | null = null;
  let endAngle: number | null = null;
  for (const segment of coupled.segments) {
    const made = skinSegment(
      segment,
      options,
      { start: contexts.start, end: contexts.end },
      { start: endRequest(options.start), end: endRequest(options.end) },
      common,
      apex,
    );
    if ('code' in made) return made;
    faces.push(made.surface);
    if (made.startAngle !== null) startAngle = Math.max(startAngle ?? 0, made.startAngle);
    if (made.endAngle !== null) endAngle = Math.max(endAngle ?? 0, made.endAngle);
  }
  const report: LoftReport = {
    sectionDeviation: sectionDeviation(faces, sections),
    startAngleRad: startAngle,
    endAngleRad: endAngle,
    faceCount: faces.length,
    fitDeviation: coupled.fitDeviation,
    seamTwistMaxRad: base.seamTwistMaxRad,
    guideDeviation: null,
    closureJumpRad: options.closed ? Math.max(...faces.map(closureJump)) : null,
  };
  return { faces, sections, report };
}
