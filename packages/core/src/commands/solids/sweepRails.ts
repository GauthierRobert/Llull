/** Rail (guide curve) params of `sweep_profile` / `sweep_surface` (SWG M4): zod fields, the derived spine of two rails, anchors, and the stored fields. */

import type { CurveSegment } from '../../model/curve';
import type { CadDocument, SweepEntity, Vec2, Vec3 } from '../../model/types';
import type { SweepOrientation, SweepRail } from '../../model/sweepOrientation';
import type { CommandResult } from '../types';
import { z } from '../schema';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { add3, cross3, distance3, len3, scale3, sub3 } from '../../lib/vec3';
import { arcLengthSamples } from '../../lib/nurbs/arcSample';
import { closestOnCurve } from '../../lib/nurbs/closest';
import { interpolatePoints } from '../../lib/nurbs/interpolate';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { curveChain } from '../../geometry/nurbsChain';
import { orientedFrames } from '../../geometry/sweepEval/frames';
import { deriveAnchors, railOffsets, type Outline, type RailIssue } from '../../geometry/sweepEval/rails';
import { worldCurves, sizeOfCurves } from '../surface/curveInputs';
import { refuseSwg } from '../surface/swgRefusal';

export const railFields = {
  guideIds: z
    .array(z.string())
    .describe(
      '1 or 2 rail curve ids (nurbs_curve). At every path station the section is pulled so its anchor points lie on the points where each rail crosses the section plane. ' +
        'With two rails and no path/pathId the spine is the midline of the rails (coupled by arc length). Not combined with twist / scale / area / stretch laws or stations.',
    )
    .optional(),
  guideMode: z
    .enum(['orient', 'scale', 'stretch'])
    .describe(
      'What the rails drive: scale (default: uniform scale + rotation; with two rails also placement), orient (rotation only, the section keeps its size), stretch (scale only along the anchor direction).',
    )
    .optional(),
  maintainHeight: z
    .boolean()
    .describe(
      'Two rails: keep the section height and stretch it only along the line between the two anchors (elliptic sections from a circle). Default false.',
    )
    .optional(),
  anchors: z
    .array(z.array(z.number()))
    .describe(
      'One [x, y] point per rail in section coordinates (the section point the rail passes through). Default: the section outline point nearest each rail at the path start, which must lie within railTolerance of the rail.',
    )
    .optional(),
  railTolerance: z
    .number()
    .describe(
      'Largest distance (document units, > 0) between a rail and the section outline at the path start when anchors are derived. Default 1e-6 x the size of the rails.',
    )
    .optional(),
};

export interface RailParams {
  readonly guideIds?: string[] | undefined;
  readonly guideMode?: 'orient' | 'scale' | 'stretch' | undefined;
  readonly maintainHeight?: boolean | undefined;
  readonly anchors?: number[][] | undefined;
  readonly railTolerance?: number | undefined;
}

type Refusal = { readonly code: string; readonly message: string; readonly path: string };

/** The rails as world curves, or the coded refusal (not 1..2 ids, unknown / non-curve id). */
export function railCurves(doc: CadDocument, command: string, ids: readonly string[]): NurbsCurveData[] | CommandResult {
  if (ids.length < 1 || ids.length > 2)
    return refuseSwg(doc, command, 'SWG_GUIDE_COUNT', `give 1 or 2 rails in guideIds (got ${ids.length})`, [...ids], ['guideIds']);
  return worldCurves(doc, command, ids, 'guideIds');
}

const SPINE_SAMPLES = [64, 128, 256];
const MID_TOLERANCE = 1e-7;

/** Midpoints of the rails at `count + 1` equal arc-length fractions. */
function midpoints(a: NurbsCurveData, b: NurbsCurveData, count: number): Vec3[] {
  const [pa, pb] = [arcLengthSamples(a, count).points, arcLengthSamples(b, count).points];
  return pa.map((p, k) => scale3(add3(p, pb[k] as Vec3), 0.5));
}

/**
 * Spine between two rails: their midline, coupled by arc-length fraction (a straight line when the midline is straight, else a cubic fitted through
 * the midpoints and checked at the in-between midpoints).
 * @failure rails of zero length, or a midline that cannot be fitted within 1e-7 of its size -> reason
 */
export function midlineSpine(a: NurbsCurveData, b: NurbsCurveData): CurveSegment<Vec3>[] | string {
  let last = Number.POSITIVE_INFINITY;
  for (const count of SPINE_SAMPLES) {
    const mids = midpoints(a, b, count);
    const first = mids[0] as Vec3;
    const end = mids[mids.length - 1] as Vec3;
    const span = distance3(first, end);
    if (!(arcLengthSamples(a, 1).length > 0 && arcLengthSamples(b, 1).length > 0)) return 'a rail has zero length';
    const direction = span > 0 ? scale3(sub3(end, first), 1 / span) : ([0, 0, 0] as Vec3);
    const sag = Math.max(...mids.map((p) => len3(cross3(sub3(p, first), direction))));
    if (span > 0 && sag <= MID_TOLERANCE * span) return [{ type: 'line', points: [first, end] }];
    const fit = interpolatePoints(mids, { degree: 3, parameterization: 'chord' });
    if ('code' in fit) return `the rails' midline cannot be fitted: ${fit.message}`;
    const probes = midpoints(a, b, 2 * count).filter((_, k) => k % 2 === 1);
    last = Math.max(...probes.map((p) => closestOnCurve(fit.curve, p).distance));
    if (last <= MID_TOLERANCE * Math.max(span, 1e-9) + 1e-9) return curveChain(fit.curve);
  }
  return `the midline of the rails deviates ${last.toExponential(2)} from its fit; give a pathId for the spine`;
}

/** The rails as stored on the sweep (local to its path start). */
export const localRails = (curves: readonly NurbsCurveData[], ids: readonly string[], start: Vec3): SweepRail[] =>
  curves.map((curve, i) => ({ curve: { ...curve, poles: curve.poles.map((p) => sub3(p, start)) }, sourceId: ids[i] as string }));

/** Fields to store for the rails (anchors given or derived), or the coded refusal. */
export function railDesign(
  geometry: Pick<SweepEntity, 'path'> & { readonly orientation: SweepOrientation | undefined; readonly outline: Outline },
  rails: readonly SweepRail[],
  input: RailParams,
  worldCurvesOf: readonly NurbsCurveData[],
): { readonly fields: Partial<SweepEntity> } | { readonly refusal: Refusal } {
  const refuse = (code: string, message: string, path: string): { refusal: Refusal } => ({ refusal: { code, message, path } });
  const tolerance = input.railTolerance ?? 1e-6 * sizeOfCurves(worldCurvesOf);
  if (!(tolerance > 0)) return refuse('SWG_PARAM_INVALID', 'railTolerance must be > 0', 'railTolerance');
  let anchors: Vec2[];
  if (input.anchors !== undefined) {
    const bad = input.anchors.findIndex((a) => a.length !== 2 || !a.every(isFiniteNumber));
    if (input.anchors.length !== rails.length || bad >= 0)
      return refuse('SWG_GUIDE_ANCHOR_UNDEFINED', `give exactly ${rails.length} anchor(s), each a finite [x, y]`, 'anchors');
    anchors = input.anchors.map((a): Vec2 => [a[0] as number, a[1] as number]);
  } else {
    const frames = orientedFrames(geometry.path, geometry.orientation, 1);
    if (!Array.isArray(frames)) return refuse(frames.code, frames.message, 'orientation');
    const offsets = railOffsets(rails, [frames[0] as (typeof frames)[number]], [0]);
    if (!Array.isArray(offsets)) return refuse((offsets as RailIssue).code, (offsets as RailIssue).message, 'guideIds');
    const derived = deriveAnchors(
      geometry.outline,
      (offsets as Vec2[][]).map((row) => row[0] as Vec2),
      tolerance,
    );
    if (!Array.isArray(derived)) return refuse((derived as RailIssue).code, (derived as RailIssue).message, 'anchors');
    anchors = derived as Vec2[];
  }
  return {
    fields: {
      rails,
      anchors,
      ...(input.guideMode === undefined ? {} : { guideMode: input.guideMode }),
      ...(input.maintainHeight === undefined ? {} : { maintainHeight: input.maintainHeight }),
    },
  };
}
