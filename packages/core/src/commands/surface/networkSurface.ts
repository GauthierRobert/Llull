/** network_surface: a Gordon surface through an unordered curve network, optionally continuing neighbouring sheets with G0 / G1 / G2 along its edges. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { gordonSurface } from '../../lib/nurbs/gordon';
import { crossFrameAt, matchingSide, sideEdge, type PatchSide } from '../../lib/nurbs/crossFrame';
import { constrainPatch } from '../../lib/nurbs/fillPatch';
import { MAX_NETWORK_CURVES, sortNetwork } from '../../lib/nurbs/network';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { placedSurface } from '../../geometry/nurbsSurface';
import { resolveSurfaceAnalysis } from '../../geometry/surfaceAnalysis/port';
import { currentContext } from '../context';
import { maxCurveDeviation, sizeOfCurves, worldCurves } from './curveInputs';
import { refuseSrf } from './shared';
import { commitSurface, isRefusal, sig, surfaceEntityOf, surfaceStyleFields } from './surfaceShared';
import { refuseSwg } from './swgRefusal';

type Boundary = PatchSide;

/**
 * @affects creates 1 nurbs_surface entity (world coordinates) through the sorted network
 * @invariant every curve of the network lies on the surface within data.deviation; with edgeMatch the named edges leave the neighbours with the measured continuity (reported)
 * @failure not 6..120 curves -> SWG_NETWORK_UNSORTABLE; curves crossing within their own family or meeting nothing -> SWG_NETWORK_UNSORTABLE; a cross pair that does not meet -> SWG_NETWORK_NOT_INTERSECTING; Gordon fit failures -> SRF_LOFT_GUIDE_*; a neighbour not on the edge -> SRF_FILL_NEIGHBOUR_MISMATCH
 */
export const networkSurface = defineCommand({
  name: 'network_surface',
  description:
    'Surface through a network of crossing curves given in ANY order (nurbs_curve ids, 6 to 120): two families of curves, every curve of one meeting every curve of the other and none meeting its own family ' +
    '(a curve net, e.g. 3 + 3 curves of a panel). The families are found by their crossings (curves within `tolerance` of each other), ordered along each other and oriented consistently, ' +
    'then a Gordon surface is fitted: u runs along the family of the FIRST id, v across it. Refused with SWG_NETWORK_UNSORTABLE when the crossing graph is not two families ' +
    '(a curve crosses its own family, or is isolated) and SWG_NETWORK_NOT_INTERSECTING naming a pair that does not meet. `edgeMatch` makes an edge of the result (u0, u1, v0, v1) ' +
    'continue an existing sheet: [{ boundary, neighbourId (a nurbs_surface whose boundary edge the edge lies on), continuity G0 | G1 | G2 }]; the measured gaps and angles are returned ' +
    '(data.boundaries). Returns data { families, crossingGap, deviation, guideDeviation, seamGap, boundaries }. Next: check_continuity, analyze_surface_curvature, check_sweep_loft.',
  params: z.object({
    curveIds: z.array(z.string()).describe('6 to 120 nurbs_curve ids forming the network, in any order and direction.'),
    tolerance: z
      .number()
      .describe('Largest gap (document units) between two curves still counted as crossing. Default 1e-4 x the size of the network.')
      .optional(),
    edgeMatch: z
      .array(
        z.object({
          boundary: z
            .enum(['u0', 'u1', 'v0', 'v1'])
            .describe('Edge of the result to match: u0 / u1 the first / last u isoline, v0 / v1 the first / last v isoline.'),
          neighbourId: z
            .string()
            .describe('Id of the nurbs_surface the edge continues; the edge must lie on one of its four boundary edges.'),
          continuity: z
            .enum(['G0', 'G1', 'G2'])
            .describe('G0 position only (measured), G1 tangent plane, G2 tangent plane and normal curvature across the edge.'),
        }),
      )
      .describe('Optional edge matching to neighbouring sheets, one entry per edge.')
      .optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { curveIds, edgeMatch = [] } = params;
    if (curveIds.length < 6 || curveIds.length > MAX_NETWORK_CURVES)
      return refuseSwg(
        doc,
        'network_surface',
        'SWG_NETWORK_UNSORTABLE',
        `a network takes 6 to ${MAX_NETWORK_CURVES} curves (got ${curveIds.length})`,
        [],
        ['curveIds'],
      );
    const curves = worldCurves(doc, 'network_surface', curveIds, 'curveIds');
    if (isRefusal(curves)) return curves;
    const size = sizeOfCurves(curves);
    const tolerance = params.tolerance ?? 1e-4 * size;
    if (!(tolerance > 0)) return refuseSwg(doc, 'network_surface', 'SWG_PARAM_INVALID', 'tolerance must be > 0', [], ['tolerance']);
    const sorted = sortNetwork(curves, tolerance);
    if ('code' in sorted)
      return refuseSwg(
        doc,
        'network_surface',
        sorted.code,
        sorted.message,
        sorted.curves.map((i) => curveIds[i] as string),
        ['curveIds'],
      );
    const gordon = gordonSurface(sorted.sections, sorted.guides, tolerance);
    if ('code' in gordon) return refuseSrf(doc, 'network_surface', gordon.code, gordon.message, curveIds, ['params.curveIds']);
    let patch: NurbsSurfaceData = gordon.surface;
    const constraints: Array<{ boundary: Boundary; continuity: 'G1' | 'G2'; surface: NurbsSurfaceData; side: PatchSide }> = [];
    const checks: Array<{ boundary: Boundary; neighbourId: string; requested: string; surface: NurbsSurfaceData; side: PatchSide }> = [];
    for (const [index, match] of edgeMatch.entries()) {
      const sheet = surfaceEntityOf(doc, 'network_surface', match.neighbourId);
      if (isRefusal(sheet)) return sheet;
      const surface = placedSurface(sheet);
      const edge = sideEdge(patch, match.boundary).curve;
      const side = matchingSide(surface, edge, Math.max(10 * tolerance, 1e-3 * size));
      if (side === null)
        return refuseSrf(
          doc,
          'network_surface',
          'SRF_FILL_NEIGHBOUR_MISMATCH',
          `edge ${match.boundary} does not lie on a boundary edge of "${match.neighbourId}"`,
          [match.neighbourId],
          [`params.edgeMatch.${index}`],
        );
      checks.push({ boundary: match.boundary, neighbourId: match.neighbourId, requested: match.continuity, surface, side });
      if (match.continuity !== 'G0') constraints.push({ boundary: match.boundary, continuity: match.continuity, surface, side });
    }
    if (constraints.length > 0) {
      const constrained = constrainPatch(
        patch,
        constraints.map((c) => ({
          curve: sideEdge(patch, c.boundary).curve,
          surface: c.surface,
          side: c.side,
          continuity: c.continuity,
          patchSide: c.boundary,
        })),
        Math.max(10 * tolerance, 1e-3 * size),
      );
      if (typeof constrained === 'string')
        return refuseSrf(doc, 'network_surface', 'SRF_FILL_UNSUPPORTED', constrained, curveIds, ['params.edgeMatch']);
      patch = constrained;
    }
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const limits = { g0: 1e-4 * size, g1AngleRad: 0.01, g2Rel: 0.1, g2Abs: 1e-9, g3Rel: 0.1, g3Abs: 1e-6 / size ** 2 };
    const boundaries = checks.map((check) => {
      const joint = engine.continuity(
        { type: 'surface', surface: check.surface, side: check.side },
        { type: 'surface', surface: patch, side: check.boundary },
        21,
        limits,
      );
      const interior = joint.samples.filter((sample) => sample.t >= 0.1 && sample.t <= 0.9);
      const g1 = Math.max(0, ...interior.map((sample) => sample.g1AngleRad));
      const g2 = Math.max(0, ...interior.map((sample) => sample.g2Gap));
      const edge = sideEdge(check.surface, check.side);
      const curvature = Math.max(
        ...[0.1, 0.5, 0.9].map((f) =>
          Math.abs(crossFrameAt(check.surface, check.side, edge.interval[0] + (edge.interval[1] - edge.interval[0]) * f).curvature),
        ),
      );
      const order =
        joint.g0Gap > limits.g0
          ? 'none'
          : g1 > limits.g1AngleRad
            ? 'G0'
            : g2 > Math.max(limits.g2Abs, limits.g2Rel * curvature)
              ? 'G1'
              : 'G2';
      return {
        boundary: check.boundary,
        neighbourId: check.neighbourId,
        requested: check.requested,
        side: check.side,
        g0Gap: sig(joint.g0Gap),
        g1AngleRad: sig(g1),
        g2Gap: sig(g2),
        order,
      };
    });
    const deviation = maxCurveDeviation(patch, curves);
    const result = commitSurface(
      doc,
      patch,
      { ...params, position: [0, 0, 0] },
      (id) =>
        `network_surface: created Gordon surface "${id}" through ${sorted.sections.length} + ${sorted.guides.length} curves (crossing gap ${sig(sorted.gap)}, deviation ${sig(deviation)} ${doc.units}${boundaries.length === 0 ? '' : `; ${boundaries.map((b) => `${b.boundary} ${b.order}`).join(', ')}`}).`,
    );
    return {
      ...result,
      data: {
        id: result.affected[0],
        families: { sections: sorted.sectionIndices.map((i) => curveIds[i]), guides: sorted.guideIndices.map((i) => curveIds[i]) },
        crossingGap: sig(sorted.gap),
        deviation: sig(deviation),
        guideDeviation: sig(gordon.guideDeviation),
        seamGap: sig(gordon.seamGap),
        boundaries,
        unit: doc.units,
      },
    };
  },
});
