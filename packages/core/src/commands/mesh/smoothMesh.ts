/** smooth_mesh — Taubin / Laplacian umbrella smoothing with optional volume correction (07 MSH FR-MSH-10). */

import { taubinMu } from '../../geometry/mesh/smooth';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import { namedDefault } from './meshCommon';
import { runMeshOp } from './runMeshOp';

/** Taubin 1995, figures 3 and 4. */
const DEFAULT_LAMBDA = 0.6307;
const DEFAULT_PASS_BAND = 0.1;
const DEFAULT_ITERATIONS = 10;

/**
 * @affects rewrites the mesh `id` with moved vertices and the same triangles (or adds one mesh with keepSource)
 * @invariant connectivity is unchanged; boundary vertices (fixBoundary) and vertices outside the region do not move; with volumeCorrection a closed result has the input's volume
 * @failure unknown id / non-solid -> MESH_*; lambda outside (0, 1] or passBand outside (0, 1/lambda) -> MESH_PARAM_INVALID
 */
export const smoothMesh = defineCommand({
  name: 'smooth_mesh',
  description:
    'Smooth the vertices of a mesh (or the triangles of any 3D solid) with the umbrella operator, connectivity unchanged. method "taubin" ' +
    '(default) alternates a shrinking step lambda and an inflating step mu = 1 / (passBand - 1 / lambda) (Taubin 1995), which removes noise above ' +
    'the pass-band frequency without the shrinkage of plain "laplacian" smoothing (which loses about 1.8 % of the radius of a sphere in 10 ' +
    'iterations at lambda 0.6307). Taubin with the paper values still grows a clean sphere slightly (+0.12 % in 10 iterations), so ' +
    'volumeCorrection (default true for closed meshes) rescales about the volume centroid to the input volume. weights "uniform" ' +
    '(default) or "cotangent". Boundary vertices stay unless fixBoundary is false; `region` restricts smoothing to a sphere. Reports data.mu, ' +
    'volumeBefore / volumeAfter (document units^3), meanDisplacement and maxDisplacement (document units) and the symmetric deviation from the input. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to smooth.'),
    method: z.enum(['taubin', 'laplacian']).optional().describe('"taubin" (default, size preserving) or "laplacian" (shrinks).'),
    lambda: z.number().gt(0).lte(1).optional().describe(`Step factor, 0..1. Default ${DEFAULT_LAMBDA} (Taubin 1995).`),
    passBand: z
      .number()
      .gt(0)
      .optional()
      .describe(
        `Taubin pass-band frequency kPB: 1 / lambda + 1 / mu. Must be below 1 / lambda. Default ${DEFAULT_PASS_BAND} (Taubin 1995: 0.01..0.1).`,
      ),
    iterations: z.number().int().min(1).max(1000).optional().describe(`Number of smoothing iterations. Default ${DEFAULT_ITERATIONS}.`),
    weights: z
      .enum(['uniform', 'cotangent'])
      .optional()
      .describe('Neighbour weights: "uniform" (default) or "cotangent" (follows the triangle shapes).'),
    fixBoundary: z.boolean().optional().describe('Keep boundary vertices of open meshes in place. Default true.'),
    volumeCorrection: z.boolean().optional().describe('Rescale a closed result to the input volume. Default true.'),
    region: z
      .object({
        center: vec3('Centre [x, y, z] of the sphere (document units, world).'),
        radius: z.number().positive().describe('Radius of the sphere (document units).'),
      })
      .optional()
      .describe('Only vertices inside this sphere are smoothed.'),
    keepSource: keepSourceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, method, lambda, passBand, iterations, weights, fixBoundary, volumeCorrection, region, keepSource } = params;
    const chosenMethod = method ?? 'taubin';
    const l = lambda ?? DEFAULT_LAMBDA;
    const band = passBand ?? DEFAULT_PASS_BAND;
    const steps = iterations ?? DEFAULT_ITERATIONS;
    return runMeshOp(doc, ctx, {
      command: 'smooth_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      deviation: true,
      precheck: () =>
        chosenMethod === 'taubin' && !(band < 1 / l)
          ? {
              code: 'MESH_PARAM_INVALID',
              message: `passBand ${band} must be below 1 / lambda = ${(1 / l).toPrecision(6)} (mu = ${taubinMu(l, band).toPrecision(6)} would not be negative)`,
              path: 'passBand',
            }
          : null,
      op: () => ({
        op: 'smooth',
        method: chosenMethod,
        lambda: l,
        passBand: band,
        iterations: steps,
        weights: weights ?? 'uniform',
        fixBoundary: fixBoundary ?? true,
        volumeCorrection: volumeCorrection ?? true,
        ...(region !== undefined ? { region: { center: region.center, radius: region.radius } } : {}),
      }),
      defaults: () => [
        ...(lambda === undefined ? [namedDefault('lambda', DEFAULT_LAMBDA, '', 'Taubin 1995')] : []),
        ...(passBand === undefined && chosenMethod === 'taubin' ? [namedDefault('passBand', DEFAULT_PASS_BAND, '', 'Taubin 1995')] : []),
        ...(iterations === undefined ? [namedDefault('iterations', DEFAULT_ITERATIONS, '', 'llull default')] : []),
      ],
      fields: (before, _after, result) => ({
        method: chosenMethod,
        lambda: l,
        passBand: band,
        iterations: steps,
        ...result.report,
        areaBefore: before.area,
      }),
      summary: (from, to, _before, _after, unit, result) =>
        `smooth_mesh '${from}' ${chosenMethod} x${steps} -> '${to}': mean displacement ${(result.report['meanDisplacement'] as number).toPrecision(4)} ${unit}, ` +
        `max ${(result.report['maxDisplacement'] as number).toPrecision(4)} ${unit}${result.report['volumeCorrected'] === true ? ', volume corrected' : ''}.`,
    });
  },
});
