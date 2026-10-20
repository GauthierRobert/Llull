/** fill_surface: a sheet inside a closed loop of boundary curves. */

import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { coonsPatch } from '../../lib/nurbs/coons';
import { reverseCurve } from '../../lib/nurbs/edit';
import { chainCurves, endOf, maxCurveDeviation, pointCurve, sizeOfCurves, worldCurves } from './curveInputs';
import { refuseSrf } from './shared';
import { commitSurface, isRefusal, sig, surfaceStyleFields } from './surfaceShared';

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
    const loop = chainCurves(curves, tolerance, true);
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
