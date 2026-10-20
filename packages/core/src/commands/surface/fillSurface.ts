/** fill_surface: a sheet inside a closed loop of 3..12 boundary curves, optionally leaving neighbouring sheets with G1 / G2. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { closestOnCurve } from '../../lib/nurbs/closest';
import { PATCH_SIDES, crossFrameAt, sideEdge, type PatchSide } from '../../lib/nurbs/crossFrame';
import { evaluateCurve } from '../../lib/nurbs/evaluate';
import { constrainPatch, fillLoop, type FillNeighbour } from '../../lib/nurbs/fillPatch';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { placedSurface } from '../../geometry/nurbsSurface';
import { resolveSurfaceAnalysis } from '../../geometry/surfaceAnalysis/port';
import { currentContext } from '../context';
import { chainCurves, maxCurveDeviation, sizeOfCurves, worldCurves } from './curveInputs';
import { refuseSrf } from './shared';
import { commitSurface, isRefusal, sig, surfaceEntityOf, surfaceStyleFields } from './surfaceShared';

const MAX_CURVES = 12;

/** The side of `surface` whose edge the curve lies on (mean distance of nine curve points to the edge), if within `tolerance`. */
function matchingSide(surface: Parameters<typeof sideEdge>[0], curve: NurbsCurveData, tolerance: number): PatchSide | null {
  const [first, last] = [curve.knots[0] as number, curve.knots[curve.knots.length - 1] as number];
  let best: { side: PatchSide; distance: number } | null = null;
  for (const side of PATCH_SIDES) {
    const edge = sideEdge(surface, side);
    let worst = 0;
    for (let k = 0; k <= 8; k++)
      worst = Math.max(worst, closestOnCurve(edge.curve, evaluateCurve(curve, first + ((last - first) * k) / 8)).distance);
    if (best === null || worst < best.distance) best = { side, distance: worst };
  }
  return best !== null && best.distance <= tolerance ? best.side : null;
}

/**
 * @affects creates 1 nurbs_surface entity bounded by the curves (world coordinates)
 * @invariant the patch contains all boundary curves (deviation reported); with `neighbours` it leaves the named sheets with the measured G1 / G2 (reported per curve)
 * @failure not 3..12 curves, ends that do not close within the tolerance -> SRF_FILL_LOOP_OPEN; rational curves -> SRF_FILL_UNSUPPORTED; unknown id -> SRF_ENTITY_NOT_FOUND; a neighbour curve not in the loop or not on an edge of its sheet -> SRF_FILL_NEIGHBOUR_MISMATCH
 */
export const fillSurface = defineCommand({
  name: 'fill_surface',
  description:
    'Fill a closed loop of 3 to 12 boundary curves (nurbs_curve ids, non-rational, in any order and orientation) with ONE surface sheet that ' +
    'contains every boundary curve exactly: the loop is grouped into the four sides of a bilinearly blended Coons patch (3 curves give a triangular ' +
    'patch with one collapsed side; with more than 4 curves neighbouring curves become one composite side, the groups chosen to balance side ' +
    'lengths). The curve ends must meet end to end within `tolerance`. By default the fill is position (G0) continuous only. `neighbours` makes it ' +
    'tangent (G1) or curvature (G2) continuous with existing sheets: each entry names a loop curve (`curveId`), the nurbs_surface (`surfaceId`) ' +
    'that has this curve as one of its four boundary edges, and `continuity` "G1" (the fill leaves the sheet perpendicular to the edge in its tangent ' +
    'plane) or "G2" (also the normal curvature across the edge). The match is made on the poles near each edge, so it is approximate between them: ' +
    'the result reports the MEASURED g0Gap and, over the middle 80 % of the edge, g1AngleRad and g2Gap per neighbour (data.boundaries; cornerG1AngleRad ' +
    'is the worst angle at the edge ends, where the adjacent boundary curves fix the surface) - read them, and run check_continuity for a full audit. ' +
    'The corner poles are never moved, so every boundary curve stays exact; at corners shared by two constrained sides the later one wins. ' +
    'Returns the surface id and the boundary deviation.',
  params: z.object({
    boundaryIds: z.array(z.string()).describe('3 to 12 nurbs_curve ids forming a closed loop.'),
    neighbours: z
      .array(
        z.object({
          curveId: z.string().describe('One of boundaryIds: the loop curve that lies on an edge of `surfaceId`.'),
          surfaceId: z.string().describe('Id of the nurbs_surface whose boundary edge is that curve.'),
          continuity: z.enum(['G1', 'G2']).describe('"G1" tangent plane or "G2" tangent plane plus normal curvature across the edge.'),
        }),
      )
      .describe('Optional G1 / G2 conditions: one entry per loop curve that must continue an existing sheet.')
      .optional(),
    tolerance: z
      .number()
      .describe('Largest gap (document units) between consecutive curve ends. Default 1e-6 x the size of the curves.')
      .optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { boundaryIds, neighbours = [] } = params;
    if (boundaryIds.length < 3 || boundaryIds.length > MAX_CURVES)
      return refuseSrf(
        doc,
        'fill_surface',
        'SRF_FILL_UNSUPPORTED',
        `fill_surface takes 3 to ${MAX_CURVES} boundary curves (got ${boundaryIds.length})`,
        [],
        ['params.boundaryIds'],
      );
    const curves = worldCurves(doc, 'fill_surface', boundaryIds, 'boundaryIds');
    if (isRefusal(curves)) return curves;
    if (curves.some((curve) => curve.weights !== undefined))
      return refuseSrf(doc, 'fill_surface', 'SRF_FILL_UNSUPPORTED', 'rational boundary curves are not supported', boundaryIds, [
        'params.boundaryIds',
      ]);
    const size = sizeOfCurves(curves);
    const tolerance = params.tolerance ?? 1e-6 * size;
    if (!(tolerance > 0)) return refuseSrf(doc, 'fill_surface', 'SRF_PARAM_INVALID', 'tolerance must be > 0', [], ['params.tolerance']);
    const loop = chainCurves(curves, tolerance, true);
    if (loop === null)
      return refuseSrf(doc, 'fill_surface', 'SRF_FILL_LOOP_OPEN', `the curves do not close into a loop within ${tolerance}`, boundaryIds, [
        'params.boundaryIds',
      ]);
    const filled = fillLoop(loop.curves);
    if (typeof filled === 'string')
      return refuseSrf(doc, 'fill_surface', 'SRF_FILL_UNSUPPORTED', filled, boundaryIds, ['params.boundaryIds']);
    const constraints: Array<FillNeighbour & { patchSide: PatchSide }> = [];
    for (const [index, neighbour] of neighbours.entries()) {
      const input = boundaryIds.indexOf(neighbour.curveId);
      const mismatch = (message: string, ids: string[]): CommandResult =>
        refuseSrf(doc, 'fill_surface', 'SRF_FILL_NEIGHBOUR_MISMATCH', message, ids, [`params.neighbours.${index}`]);
      if (input < 0) return mismatch(`neighbours.${index}.curveId "${neighbour.curveId}" is not one of boundaryIds`, [neighbour.curveId]);
      const sheet = surfaceEntityOf(doc, 'fill_surface', neighbour.surfaceId);
      if (isRefusal(sheet)) return sheet;
      if ((sheet.trims?.length ?? 0) > 0)
        return refuseSrf(
          doc,
          'fill_surface',
          'SRF_TRIM_UNSUPPORTED',
          'a sheet trimmed by curves cannot be a G1 / G2 neighbour (its edges are not the patch edges)',
          [neighbour.surfaceId],
          [`params.neighbours.${index}`],
        );
      const surface = placedSurface(sheet);
      const loopIndex = loop.order.indexOf(input);
      const curve = loop.curves[loopIndex] as NurbsCurveData;
      const side = matchingSide(surface, curve, Math.max(1e-4 * size, tolerance));
      if (side === null)
        return mismatch(`curve "${neighbour.curveId}" does not lie on a boundary edge of "${neighbour.surfaceId}"`, [
          neighbour.curveId,
          neighbour.surfaceId,
        ]);
      constraints.push({ curve, surface, side, continuity: neighbour.continuity, patchSide: filled.sideOfCurve[loopIndex] as PatchSide });
    }
    const patch = constraints.length === 0 ? filled.surface : constrainPatch(filled.surface, constraints, Math.max(1e-5 * size, tolerance));
    if (typeof patch === 'string')
      return refuseSrf(doc, 'fill_surface', 'SRF_FILL_UNSUPPORTED', patch, boundaryIds, ['params.boundaryIds']);
    const deviation = maxCurveDeviation(patch, loop.curves);
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const tolerances = { g0: 1e-4 * size, g1AngleRad: 0.01, g2Rel: 0.1, g2Abs: 1e-9, g3Rel: 0.1, g3Abs: 1e-6 / size ** 2 };
    const boundaries = constraints.map((constraint, index) => {
      const joint = engine.continuity(
        { type: 'surface', surface: constraint.surface, side: constraint.side },
        { type: 'surface', surface: patch, side: constraint.patchSide },
        21,
        tolerances,
      );
      // the ends of an edge sit on the corners, where the adjacent boundary curves fix the surface: the headline figures are those of the middle 80 %
      const interior = joint.samples.filter((sample) => sample.t >= 0.1 && sample.t <= 0.9);
      const [g0, g1, g2] = [
        Math.max(0, ...interior.map((sample) => sample.g0Gap)),
        Math.max(0, ...interior.map((sample) => sample.g1AngleRad)),
        Math.max(0, ...interior.map((sample) => sample.g2Gap)),
      ];
      const edge = sideEdge(constraint.surface, constraint.side);
      const curvature = Math.max(
        ...[0.1, 0.5, 0.9].map((f) =>
          Math.abs(
            crossFrameAt(constraint.surface, constraint.side, edge.interval[0] + (edge.interval[1] - edge.interval[0]) * f).curvature,
          ),
        ),
      );
      const order =
        g0 > tolerances.g0
          ? 'none'
          : g1 > tolerances.g1AngleRad
            ? 'G0'
            : g2 > Math.max(tolerances.g2Abs, tolerances.g2Rel * curvature)
              ? 'G1'
              : 'G2';
      return {
        curveId: (neighbours[index] as { curveId: string }).curveId,
        surfaceId: (neighbours[index] as { surfaceId: string }).surfaceId,
        requested: constraint.continuity,
        side: constraint.side,
        fillSide: constraint.patchSide,
        g0Gap: sig(joint.g0Gap),
        g1AngleRad: sig(g1),
        g2Gap: sig(g2),
        cornerG1AngleRad: sig(joint.g1AngleRad),
        order,
      };
    });
    const result = commitSurface(
      doc,
      patch,
      { ...params, position: [0, 0, 0] },
      (id) =>
        `fill_surface: filled ${boundaryIds.length} boundary curves with ${filled.groups.filter((g) => g.length > 0).length === 4 ? '' : 'triangular '}Coons patch "${id}" ` +
        `(${patch.poles.length} x ${patch.poles[0]?.length ?? 0} poles, loop gap ${sig(loop.gap)}, boundary deviation ${sig(deviation)} ${doc.units}; ` +
        `${constraints.length === 0 ? 'G0 only' : boundaries.map((b) => `${b.curveId} ${b.order}`).join(', ')}).`,
    );
    return {
      ...result,
      data: {
        id: result.affected[0],
        sides: boundaryIds.length,
        boundaryDeviation: sig(deviation),
        loopGap: sig(loop.gap),
        boundaries,
        unit: doc.units,
        engine: engine.provenance.engine,
        unverified: false,
        provenance: {
          method:
            'Coons patch over four (composite) sides; pole rows next to constrained sides re-placed on the neighbour tangent plane / normal curvature',
          reference: 'Farin, Curves and Surfaces for CAGD ch. 20; Pegna-Wolter G2 criterion',
          inputs: { boundaryIds, neighbours: neighbours.length },
        },
      },
    };
  },
});
