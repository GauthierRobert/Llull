/** loft_surface (skinning, optionally through a guide network) and fill_surface (Coons patch inside 3 or 4 boundary curves). */

import type { CadDocument, NurbsCurveEntity, Vec3 } from '../../model/types';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { coonsPatch } from '../../lib/nurbs/coons';
import { gordonSurface } from '../../lib/nurbs/gordon';
import { skinCurves } from '../../lib/nurbs/surfaceFit';
import { closestOnSurface, surfaceProbe } from '../../lib/nurbs/closest';
import { reverseCurve } from '../../lib/nurbs/edit';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import { distance3 } from '../../lib/vec3';
import { placedCurve } from '../../geometry/nurbsSurface';
import { poleExtent } from '../../geometry/nurbsCurve';
import { curveEntityOf, refuseSrf } from './shared';
import { commitSurface, isRefusal, sig, surfaceStyleFields } from './surfaceShared';

const MAX_SECTIONS = 60;

/** The curves `ids` as world curves, or the first coded refusal. */
function worldCurves(doc: CadDocument, command: string, ids: ReadonlyArray<string>, path: string): NurbsCurveData[] | CommandResult {
  const curves: NurbsCurveData[] = [];
  for (const [index, id] of ids.entries()) {
    const entity = curveEntityOf(doc, command, id);
    if (!('curve' in entity))
      return refuseSrf(doc, command, entity.error?.code ?? 'SRF_NOT_NURBS', entity.summary, [id], [`params.${path}.${index}`]);
    curves.push(placedCurve(entity as NurbsCurveEntity));
  }
  return curves;
}

const sizeOfCurves = (curves: ReadonlyArray<NurbsCurveData>): number =>
  curves.reduce((size, curve) => {
    const { min, max } = poleExtent(curve);
    return Math.max(size, max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }, 1e-9);

/** Largest distance from sample points of `curves` to `surface`. */
function maxCurveDeviation(surface: NurbsSurfaceData, curves: ReadonlyArray<NurbsCurveData>): number {
  const probe = surfaceProbe(surface);
  let worst = 0;
  for (const curve of curves) {
    const [a, b] = curveDomain(curve);
    for (let s = 0; s <= 12; s++)
      worst = Math.max(worst, closestOnSurface(surface, evaluateCurve(curve, a + ((b - a) * s) / 12), probe).distance);
  }
  return worst;
}

/**
 * @affects creates 1 nurbs_surface entity (world coordinates, position [0,0,0]) skinned through the sections
 * @invariant every section is reproduced (rational sections stay exact); with guides the patch also contains every guide (Gordon network, fitted)
 * @failure fewer than 2 sections -> SRF_LOFT_SECTIONS_TOO_FEW; unknown id / not a curve -> SRF_ENTITY_NOT_FOUND / SRF_NOT_NURBS; a guide missing a section -> SRF_LOFT_GUIDE_MISSES_SECTION; incompatible curves -> SRF_NURBS_INVALID
 */
export const loftSurface = defineCommand({
  name: 'loft_surface',
  description:
    'Skin a NURBS surface sheet through ordered section curves (nurbs_curve ids, e.g. from interpolate_curve, create_conic or airfoil_from_naca): ' +
    'u runs along each section, v across the sections in the order given. The sections are not resampled: they are made compatible ' +
    '(common degree and knots, exact) and the v poles interpolate them, so rational sections such as circles stay exact. Sections must ' +
    'start at corresponding points and run the same way. Optional `guideIds` (curves crossing every section within `guideTolerance`) turn ' +
    'it into a Gordon surface: the result contains the guides as well as the sections (fitted bicubic; the section deviation is reported). ' +
    '`degreeV` is the degree across the sections (1..5, default 3 capped by sections - 1; 1 gives a ruled skin). This is the sheet counterpart of ' +
    'loft_sections (which makes a solid). Next: analyze_surface_curvature, check_continuity, thicken_surface.',
  params: z.object({
    sectionIds: z.array(z.string()).describe('2..60 ordered nurbs_curve ids to skin through.'),
    guideIds: z
      .array(z.string())
      .describe('Optional nurbs_curve ids of guide curves that cross every section, listed across the sections.')
      .optional(),
    degreeV: z.number().describe('Degree across the sections, integer 1..5. Default 3 (capped by the number of sections - 1).').optional(),
    guideTolerance: z
      .number()
      .describe(
        'Largest distance (document units) between a guide and a section still counted as meeting. Default 1e-4 x the size of the curves.',
      )
      .optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { sectionIds, guideIds = [] } = params;
    if (sectionIds.length < 2)
      return refuseSrf(
        doc,
        'loft_surface',
        'SRF_LOFT_SECTIONS_TOO_FEW',
        `a loft needs at least 2 sections (got ${sectionIds.length})`,
        [],
        ['params.sectionIds'],
      );
    if (sectionIds.length > MAX_SECTIONS || guideIds.length > MAX_SECTIONS)
      return refuseSrf(doc, 'loft_surface', 'SRF_PARAM_INVALID', `at most ${MAX_SECTIONS} sections and guides`, [], ['params.sectionIds']);
    const sections = worldCurves(doc, 'loft_surface', sectionIds, 'sectionIds');
    if (isRefusal(sections)) return sections;
    const guides = worldCurves(doc, 'loft_surface', guideIds, 'guideIds');
    if (isRefusal(guides)) return guides;
    const degreeV = Math.min(params.degreeV ?? 3, sections.length - 1);
    if (guides.length === 0) {
      const skin = skinCurves(sections, degreeV);
      if ('code' in skin) return refuseSrf(doc, 'loft_surface', skin.code, skin.message, [], ['params.sectionIds']);
      const deviation = maxCurveDeviation(skin, sections);
      return commitSurface(
        doc,
        skin,
        { ...params, position: [0, 0, 0] },
        (id) =>
          `loft_surface: created ${skin.degreeU}x${skin.degreeV} surface "${id}" through ${sections.length} sections (max section deviation ${sig(deviation)} ${doc.units}).`,
      );
    }
    const tolerance = params.guideTolerance ?? 1e-4 * sizeOfCurves([...sections, ...guides]);
    if (!(tolerance > 0))
      return refuseSrf(doc, 'loft_surface', 'SRF_PARAM_INVALID', 'guideTolerance must be > 0', [], ['params.guideTolerance']);
    const gordon = gordonSurface(sections, guides, tolerance);
    if ('code' in gordon)
      return refuseSrf(
        doc,
        'loft_surface',
        gordon.code,
        gordon.message,
        [...(gordon.guide === undefined ? [] : [guideIds[gordon.guide] as string])],
        ['params.guideIds'],
      );
    return commitSurface(
      doc,
      gordon.surface,
      { ...params, position: [0, 0, 0] },
      (id) =>
        `loft_surface: created Gordon surface "${id}" through ${sections.length} sections and ${guides.length} guide(s) (guide gap ${sig(gordon.gap)}, max section deviation ${sig(gordon.deviation)} ${doc.units}).`,
    );
  },
});

interface OrientedLoop {
  readonly curves: NurbsCurveData[];
  readonly gap: number;
}

const endOf = (curve: NurbsCurveData, which: 0 | 1): Vec3 => evaluateCurve(curve, curveDomain(curve)[which]);

/** The curves chained end to end into a closed loop (each oriented along the loop), or null when they do not close within `tolerance`. */
function chainLoop(curves: ReadonlyArray<NurbsCurveData>, tolerance: number): OrientedLoop | null {
  const remaining = curves.slice(1);
  const loop: NurbsCurveData[] = [curves[0] as NurbsCurveData];
  let gap = 0;
  while (remaining.length > 0) {
    const tail = endOf(loop[loop.length - 1] as NurbsCurveData, 1);
    let best: { index: number; reversed: boolean; distance: number } | null = null;
    remaining.forEach((curve, index) => {
      for (const [reversed, which] of [
        [false, 0],
        [true, 1],
      ] as const) {
        const distance = distance3(tail, endOf(curve, which));
        if (best === null || distance < best.distance) best = { index, reversed, distance };
      }
    });
    const pick = best as { index: number; reversed: boolean; distance: number } | null;
    if (pick === null || pick.distance > tolerance) return null;
    gap = Math.max(gap, pick.distance);
    const [curve] = remaining.splice(pick.index, 1) as [NurbsCurveData];
    loop.push(pick.reversed ? reverseCurve(curve) : curve);
  }
  const close = distance3(endOf(loop[loop.length - 1] as NurbsCurveData, 1), endOf(loop[0] as NurbsCurveData, 0));
  return close > tolerance ? null : { curves: loop, gap: Math.max(gap, close) };
}

/** A zero-length curve at `point` (the collapsed fourth side of a triangular patch). */
const pointCurve = (point: Vec3): NurbsCurveData => ({ degree: 1, poles: [point, point], knots: [0, 1], multiplicities: [2, 2] });

/**
 * @affects creates 1 nurbs_surface entity bounded by the curves
 * @invariant G0 only: the patch contains all boundary curves (deviation reported); tangent / curvature constraints are not imposed
 * @failure not 3 or 4 curves, ends that do not close within the tolerance -> SRF_FILL_LOOP_OPEN; rational curves -> SRF_FILL_UNSUPPORTED; unknown id -> SRF_ENTITY_NOT_FOUND
 */
export const fillSurface = defineCommand({
  name: 'fill_surface',
  description:
    'Fill a closed loop of 3 or 4 boundary curves (nurbs_curve ids, non-rational, in any order and orientation) with a surface sheet: a ' +
    'bilinearly blended Coons patch that contains every boundary curve exactly (3 curves give a triangular patch with one collapsed side). ' +
    'The curve ends must meet end to end within `tolerance`. The fill is position (G0) continuous only: it does not match tangents or curvature ' +
    'of neighbouring surfaces - check the result with check_continuity. Loops of more than 4 curves and G1 / G2 fills need the exact kernel ' +
    'and are not available. Returns the surface id and the boundary deviation.',
  params: z.object({
    boundaryIds: z.array(z.string()).describe('3 or 4 nurbs_curve ids forming a closed loop.'),
    tolerance: z
      .number()
      .describe('Largest gap (document units) between consecutive curve ends. Default 1e-6 x the size of the curves.')
      .optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { boundaryIds } = params;
    if (boundaryIds.length < 3 || boundaryIds.length > 4)
      return refuseSrf(
        doc,
        'fill_surface',
        'SRF_FILL_UNSUPPORTED',
        `fill_surface takes 3 or 4 boundary curves (got ${boundaryIds.length})`,
        [],
        ['params.boundaryIds'],
      );
    const curves = worldCurves(doc, 'fill_surface', boundaryIds, 'boundaryIds');
    if (isRefusal(curves)) return curves;
    if (curves.some((curve) => curve.weights !== undefined))
      return refuseSrf(doc, 'fill_surface', 'SRF_FILL_UNSUPPORTED', 'rational boundary curves are not supported', boundaryIds, [
        'params.boundaryIds',
      ]);
    const tolerance = params.tolerance ?? 1e-6 * sizeOfCurves(curves);
    if (!(tolerance > 0)) return refuseSrf(doc, 'fill_surface', 'SRF_PARAM_INVALID', 'tolerance must be > 0', [], ['params.tolerance']);
    const loop = chainLoop(curves, tolerance);
    if (loop === null)
      return refuseSrf(doc, 'fill_surface', 'SRF_FILL_LOOP_OPEN', `the curves do not close into a loop within ${tolerance}`, boundaryIds, [
        'params.boundaryIds',
      ]);
    const [c0, c1, c2, c3] = loop.curves;
    const patch =
      c3 === undefined
        ? coonsPatch(
            c0 as NurbsCurveData,
            reverseCurve(c2 as NurbsCurveData),
            pointCurve(endOf(c0 as NurbsCurveData, 0)),
            c1 as NurbsCurveData,
          )
        : coonsPatch(c0 as NurbsCurveData, reverseCurve(c2 as NurbsCurveData), reverseCurve(c3), c1 as NurbsCurveData);
    if (typeof patch === 'string')
      return refuseSrf(doc, 'fill_surface', 'SRF_FILL_UNSUPPORTED', patch, boundaryIds, ['params.boundaryIds']);
    const deviation = maxCurveDeviation(patch, loop.curves);
    return commitSurface(
      doc,
      patch,
      { ...params, position: [0, 0, 0] },
      (id) =>
        `fill_surface: filled ${boundaryIds.length} boundary curves with Coons patch "${id}" (${patch.poles.length} x ${patch.poles[0]?.length ?? 0} poles, loop gap ${sig(loop.gap)}, boundary deviation ${sig(deviation)} ${doc.units}; G0 only).`,
    );
  },
});
