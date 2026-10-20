/** blend_surfaces: a G1 / G2 blend sheet between an edge of one sheet and an edge of another. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { closestOnCurve } from '../../lib/nurbs/closest';
import { PATCH_SIDES, sideEdge, type PatchSide } from '../../lib/nurbs/crossFrame';
import { buildBlend } from '../../lib/nurbs/blendPatch';
import { evaluateCurve } from '../../lib/nurbs/evaluate';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { placedSurface, surfacePoleExtent } from '../../geometry/nurbsSurface';
import { resolveSurfaceAnalysis } from '../../geometry/surfaceAnalysis/port';
import type { ContinuityJoint } from '../../geometry/surfaceAnalysis/types';
import { currentContext } from '../context';
import { refuseSrf } from './shared';
import { commitSurface, isRefusal, sig, surfaceEntityOf, surfaceStyleFields } from './surfaceShared';

const sideField = z
  .enum(['u0', 'u1', 'v0', 'v1'])
  .describe(
    'Boundary edge of the sheet to blend from: "u0" / "u1" = the edge at the lowest / highest u, "v0" / "v1" likewise for v. Omit to detect the closest pair.',
  )
  .optional();

/** The side pair whose edges lie closest to each other (mean distance of five points along the first edge to the second). */
function nearestSides(a: NurbsSurfaceData, b: NurbsSurfaceData, sideA?: PatchSide, sideB?: PatchSide): [PatchSide, PatchSide] {
  let best: { sides: [PatchSide, PatchSide]; score: number } | null = null;
  for (const candidateA of sideA === undefined ? PATCH_SIDES : [sideA])
    for (const candidateB of sideB === undefined ? PATCH_SIDES : [sideB]) {
      const [edgeA, edgeB] = [sideEdge(a, candidateA), sideEdge(b, candidateB)];
      let score = 0;
      for (let k = 0; k < 5; k++) {
        const t = edgeA.interval[0] + ((edgeA.interval[1] - edgeA.interval[0]) * k) / 4;
        score += closestOnCurve(edgeB.curve, evaluateCurve(edgeA.curve, t)).distance;
      }
      if (best === null || score < best.score) best = { sides: [candidateA, candidateB], score };
    }
  return (best as NonNullable<typeof best>).sides;
}

const jointData = (side: PatchSide, joint: ContinuityJoint): Record<string, unknown> => ({
  side,
  g0Gap: sig(joint.g0Gap),
  g1AngleRad: sig(joint.g1AngleRad),
  g2Gap: sig(joint.g2Gap),
  g2Rel: sig(joint.g2Rel),
  order: joint.order,
});

/**
 * @affects creates 1 nurbs_surface (world coordinates) joining the two edges; the inputs are kept
 * @invariant the blend contains the edge of A (v = 0) and its foot-point matches on the edge of B (v = 1); the measured G0 / G1 / G2 of both joints are reported
 * @failure unknown id / not a surface -> SRF_ENTITY_NOT_FOUND / SRF_NOT_SURFACE; same sheet twice, bad factor / stations -> SRF_PARAM_INVALID; touching edges, singular edge -> SRF_BLEND_DEGENERATE; sheets facing away -> SRF_BLEND_FOLD
 */
export const blendSurfaces = defineCommand({
  name: 'blend_surfaces',
  description:
    'Create a blend sheet that bridges the gap between one boundary edge of nurbs_surface `a` and one of nurbs_surface `b` with tangent (G1) or ' +
    'curvature (G2) continuity at both ends. `continuity` "G1": the blend leaves each sheet in its tangent plane (cubic across); "G2": it also ' +
    'matches the normal curvature across each edge (quintic across). `factor` scales the end tangents (fraction of the gap, default 1: larger ' +
    'bulges more). The edges are matched point to point (each station of the first edge goes to its foot point on the second), so they should ' +
    'face each other: the sheets must leave their edges towards the other one (otherwise SRF_BLEND_FOLD). The blend is a new sheet (the inputs are ' +
    'kept; sew_surfaces or check_continuity next). The result reports the MEASURED continuity of both joints (g0Gap, g1AngleRad, g2Gap, order): ' +
    'the match is exact at the stations and approximate (interpolation) between them, so read `order` rather than assuming it. ' +
    'Reference: two pieces of the parabolic cylinder z = x^2 / 2 at x in [0, 1] and [2, 3] blend with G2.',
  params: z.object({
    a: z.object({ id: z.string().describe('Id of the first nurbs_surface.'), side: sideField }).describe('First sheet and its edge.'),
    b: z.object({ id: z.string().describe('Id of the second nurbs_surface.'), side: sideField }).describe('Second sheet and its edge.'),
    continuity: z
      .enum(['G1', 'G2'])
      .describe('"G1" tangent-plane continuity (default) or "G2" curvature continuity across both edges.')
      .optional(),
    factor: z.number().describe('End tangent length as a fraction of the gap between the edges, 0.05..3. Default 1.').optional(),
    stations: z.number().describe('Stations along the edge used to build the blend, integer 5..129. Default 33.').optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { a, b, continuity = 'G1', factor = 1, stations = 33 } = params;
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'blend_surfaces', 'SRF_PARAM_INVALID', message, [a.id, b.id], [`params.${path}`]);
    if (a.id === b.id && a.side === b.side) return invalid('a and b name the same edge of the same sheet', 'b');
    if (!(factor >= 0.05 && factor <= 3)) return invalid(`factor must be within 0.05..3 (got ${factor})`, 'factor');
    if (!(Number.isInteger(stations) && stations >= 5 && stations <= 129))
      return invalid(`stations must be an integer in 5..129 (got ${stations})`, 'stations');
    const [first, second] = [surfaceEntityOf(doc, 'blend_surfaces', a.id), surfaceEntityOf(doc, 'blend_surfaces', b.id)];
    if (isRefusal(first)) return first;
    if (isRefusal(second)) return second;
    const [surfaceA, surfaceB] = [placedSurface(first), placedSurface(second)];
    const [sideA, sideB] = nearestSides(surfaceA, surfaceB, a.side, b.side);
    const built = buildBlend({ a: surfaceA, sideA, b: surfaceB, sideB, continuity, factor, stations });
    if ('code' in built) return refuseSrf(doc, 'blend_surfaces', built.code, built.message, [a.id, b.id], ['params.a', 'params.b']);
    const extent = [surfacePoleExtent(surfaceA), surfacePoleExtent(surfaceB)].flatMap(({ min, max }) => [
      max[0] - min[0],
      max[1] - min[1],
      max[2] - min[2],
    ]);
    const size = Math.max(...extent, 1e-9);
    const tolerances = { g0: 1e-5 * size, g1AngleRad: 0.01, g2Rel: 0.1, g2Abs: 1e-9, g3Rel: 0.1 };
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const jointA = engine.continuity(
      { type: 'surface', surface: surfaceA, side: sideA },
      { type: 'surface', surface: built.surface, side: 'v0' },
      21,
      tolerances,
    );
    const jointB = engine.continuity(
      { type: 'surface', surface: surfaceB, side: sideB },
      { type: 'surface', surface: built.surface, side: 'v1' },
      21,
      tolerances,
    );
    const result = commitSurface(
      doc,
      built.surface,
      { ...params, position: [0, 0, 0] },
      (id) =>
        `blend_surfaces: created ${continuity} blend "${id}" between "${a.id}" ${sideA} and "${b.id}" ${sideB} (gap ${sig(built.meanGap)} mean / ${sig(built.maxGap)} max ${doc.units}; ` +
        `joint A ${jointA.order}, joint B ${jointB.order}).`,
    );
    const id = result.affected[0] as string;
    return {
      ...result,
      data: {
        id,
        continuity,
        factor,
        stations,
        gap: { mean: sig(built.meanGap), max: sig(built.maxGap) },
        a: { id: a.id, ...jointData(sideA, jointA) },
        b: { id: b.id, ...jointData(sideB, jointB) },
        unit: doc.units,
        engine: engine.provenance.engine,
        unverified: false,
        provenance: {
          method:
            'Hermite / Bezier blend across the gap (cubic G1, quintic G2) interpolated along the edge; continuity measured by check_continuity machinery',
          reference: 'Farin, Curves and Surfaces for CAGD ch. 20; Pegna-Wolter G2 criterion',
          inputs: { a: a.id, b: b.id, sideA, sideB, stations },
        },
      },
    };
  },
});
