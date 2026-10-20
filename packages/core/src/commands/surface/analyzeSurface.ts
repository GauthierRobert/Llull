/** analyze_surface_curvature and analyze_draft: read-only queries of a surface sheet (and, for draft, of any 3D solid). */

import type { Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { report } from '../noop';
import { len3 } from '../../lib/vec3';
import { surfaceDomain } from '../../lib/nurbs/surface';
import { placedSurface } from '../../geometry/nurbsSurface';
import { resolveSurfaceAnalysis } from '../../geometry/surfaceAnalysis/port';
import { refuseSrf } from './shared';
import { analysisTarget, isRefusal, sig, sigVec, surfaceEntityOf } from './surfaceShared';
import { currentContext } from '../context';

/** Samples listed one by one in `data.samples` (larger grids only report the statistics and the extremes). */
const MAX_LISTED_SAMPLES = 2_500;
const MAX_GRID = 200;
const MAX_EXPLICIT = 10_000;

/**
 * @affects none; data = { id, grid, samples?, extremes, minGaussian, maxGaussian, minMean, maxMean, maxAbsCurvature, degenerateSamples, unit, curvatureUnit, engine, provenance }
 * @invariant K = (LN - M^2) / (EG - F^2), H = (EN + GL - 2FM) / (2 (EG - F^2)), k1 >= k2 = H +- sqrt(H^2 - K); exact derivatives of the NURBS
 * @failure unknown id -> SRF_ENTITY_NOT_FOUND; not a nurbs_surface -> SRF_NOT_SURFACE; bad grid / parameters -> SRF_PARAM_INVALID
 */
export const analyzeSurfaceCurvature = defineCommand({
  name: 'analyze_surface_curvature',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only curvature analysis of a nurbs_surface (made by loft_surface, surface_from_points, fill_surface, loft_fuselage ...): at a ' +
    '`grid` of [nu, nv] equally spaced parameter points (each 2..200, default [11, 11]) or at explicit `samples` [u, v] (inside the domain, see ' +
    'inspect_nurbs), return the world point, unit normal, principal curvatures k1 >= k2, Gaussian curvature K = k1*k2 and mean curvature ' +
    'H = (k1+k2)/2 (1/document unit, signed about the normal). The summary reports min / max K and H and where they occur (flat spots: K ~ 0, ' +
    'bumps and dents: large |K|). `data.samples` is listed up to 2500 samples; larger grids return only the statistics and `extremes`. Samples ' +
    'on a singular point (a collapsed edge, a pole) are flagged `degenerate` and excluded from the statistics.',
  params: z.object({
    id: z.string().describe('Id of a nurbs_surface entity.'),
    grid: z
      .array(z.number())
      .describe(
        '[nu, nv]: number of sample parameters along u and along v, integers 2..200 each. Default [11, 11]. Ignored when `samples` is given.',
      )
      .optional(),
    samples: z.array(z.array(z.number())).describe('Explicit [u, v] parameter pairs inside the surface domain, at most 10000.').optional(),
  }),
  run: (doc, { id, grid = [11, 11], samples }, ctx): CommandResult => {
    const entity = surfaceEntityOf(doc, 'analyze_surface_curvature', id);
    if (isRefusal(entity)) return entity;
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'analyze_surface_curvature', 'SRF_PARAM_INVALID', message, [id], [`params.${path}`]);
    const surface = placedSurface(entity);
    const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
    let parameters: Array<readonly [number, number]>;
    if (samples !== undefined) {
      if (samples.length === 0 || samples.length > MAX_EXPLICIT || samples.some((s) => s.length !== 2))
        return invalid(`samples needs 1..${MAX_EXPLICIT} pairs [u, v]`, 'samples');
      const outside = samples.findIndex(
        ([u, v]) => !((u as number) >= u0 && (u as number) <= u1 && (v as number) >= v0 && (v as number) <= v1),
      );
      if (outside >= 0) return invalid(`sample ${outside} is outside the domain u [${u0}, ${u1}], v [${v0}, ${v1}]`, `samples.${outside}`);
      parameters = samples.map(([u, v]) => [u as number, v as number] as const);
    } else {
      const [nu, nv] = grid;
      if (grid.length !== 2 || ![nu, nv].every((n) => Number.isInteger(n) && (n as number) >= 2 && (n as number) <= MAX_GRID))
        return invalid(`grid must be [nu, nv] with integers in 2..${MAX_GRID}`, 'grid');
      parameters = [];
      for (let i = 0; i < (nu as number); i++)
        for (let j = 0; j < (nv as number); j++)
          parameters.push([u0 + ((u1 - u0) * i) / ((nu as number) - 1), v0 + ((v1 - v0) * j) / ((nv as number) - 1)] as const);
    }
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const rows = engine.curvature(surface, parameters);
    const live = rows.filter((row) => !row.degenerate);
    const extreme = (pick: (row: (typeof rows)[number]) => number, sign: 1 | -1): (typeof rows)[number] | null =>
      live.reduce<(typeof rows)[number] | null>((best, row) => (best === null || sign * pick(row) > sign * pick(best) ? row : best), null);
    const describe = (row: (typeof rows)[number] | null, pick: (row: (typeof rows)[number]) => number): unknown =>
      row === null ? null : { u: sig(row.u), v: sig(row.v), point: sigVec(row.point), value: sig(pick(row)) };
    const [gaussian, mean] = [(row: (typeof rows)[number]) => row.gaussian, (row: (typeof rows)[number]) => row.mean];
    const [minK, maxK, minH, maxH] = [extreme(gaussian, -1), extreme(gaussian, 1), extreme(mean, -1), extreme(mean, 1)];
    const maxAbs = live.reduce((best, row) => Math.max(best, Math.abs(row.k1), Math.abs(row.k2)), 0);
    const listed = rows.length <= MAX_LISTED_SAMPLES;
    const data = {
      id,
      grid: samples === undefined ? grid : null,
      sampleCount: rows.length,
      ...(listed
        ? {
            samples: rows.map((row) => ({
              u: sig(row.u),
              v: sig(row.v),
              point: sigVec(row.point),
              normal: sigVec(row.normal),
              k1: sig(row.k1),
              k2: sig(row.k2),
              gaussian: sig(row.gaussian),
              mean: sig(row.mean),
              degenerate: row.degenerate,
            })),
          }
        : { samplesOmitted: `${rows.length} samples exceed ${MAX_LISTED_SAMPLES}; use a smaller grid or explicit samples to list them` }),
      extremes: {
        minGaussian: describe(minK, gaussian),
        maxGaussian: describe(maxK, gaussian),
        minMean: describe(minH, mean),
        maxMean: describe(maxH, mean),
      },
      minGaussian: minK === null ? 0 : sig(minK.gaussian),
      maxGaussian: maxK === null ? 0 : sig(maxK.gaussian),
      minMean: minH === null ? 0 : sig(minH.mean),
      maxMean: maxH === null ? 0 : sig(maxH.mean),
      maxAbsCurvature: sig(maxAbs),
      degenerateSamples: rows.length - live.length,
      unit: doc.units,
      curvatureUnit: `1/${doc.units}`,
      engine: engine.provenance.engine,
      unverified: false,
      provenance: {
        method:
          'principal curvatures from the first and second fundamental forms of the exact rational B-spline (quotient-rule derivatives)',
        reference: 'Piegl & Tiller, The NURBS Book, A3.6 / A4.4; do Carmo, Differential Geometry of Curves and Surfaces',
        inputs: { id, samples: rows.length },
      },
    };
    return report(
      doc,
      `analyze_surface_curvature ${id}: ${rows.length} samples (${rows.length - live.length} degenerate), Gaussian K ${data.minGaussian}..${data.maxGaussian} 1/${doc.units}^2, ` +
        `mean H ${data.minMean}..${data.maxMean} 1/${doc.units}, max |k| ${data.maxAbsCurvature}.`,
      data,
    );
  },
});

/**
 * @affects none; data = { id, pullDirection, minDraftDeg, samples (thinned), minDeg, maxDeg, totalArea, areaBelowMin, areaBelowMinFraction, undercutArea, undercut, pass, unit, provenance }
 * @invariant draft = asin(n . pull) in degrees with the outward unit normal n; negative draft is an undercut
 * @failure unknown id -> SRF_ENTITY_NOT_FOUND; a 2D shape / instance -> SRF_NOT_ANALYSABLE; zero pull direction, bad grid -> SRF_PARAM_INVALID
 */
export const analyzeDraft = defineCommand({
  name: 'analyze_draft',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only draft analysis against a mould pull direction. `id` is a nurbs_surface (sampled on a `grid` x `grid` patch grid) or a 3D solid ' +
    '(every facet of its tessellation; the exact kernel is not needed). The draft angle of a face is asin(n . pull) in degrees, n the outward ' +
    'unit normal: 0 = parallel to the pull, positive = the face leans away so the part releases, negative = an undercut. A cone with the pull ' +
    'along its axis and base radius 5, top radius 3, height 10 has a lateral draft of atan(0.2) = 11.31 degrees. Returns min / max draft, ' +
    'the area below `minDraftDeg` (default 0 = undercuts only) and the undercut area, with `pass` true when no face is below the minimum. ' +
    'A sheet has no inside: set `flip` true when its normal (S_u x S_v) points into the part. Samples are listed up to 2000 (thinned evenly).',
  params: z.object({
    id: z.string().describe('Id of a nurbs_surface or a 3D solid entity.'),
    pullDirection: vec3('Direction [x, y, z] the part is pulled out of the mould (any non-zero length), e.g. [0, 0, 1].'),
    minDraftDeg: z.number().describe('Smallest acceptable draft angle in degrees (-90..90). Default 0.').optional(),
    grid: z.number().describe('Samples per direction for a nurbs_surface, integer 2..200. Default 20. Ignored for solids.').optional(),
    flip: z
      .boolean()
      .describe('Reverse the normal of a nurbs_surface (S_u x S_v) before measuring. Default false; ignored for solids.')
      .optional(),
  }),
  run: (doc, { id, pullDirection, minDraftDeg = 0, grid = 20, flip = false }, ctx): CommandResult => {
    const target = analysisTarget(doc, 'analyze_draft', id);
    if (isRefusal(target)) return target;
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'analyze_draft', 'SRF_PARAM_INVALID', message, [id], [`params.${path}`]);
    if (target.shape.type === 'curve')
      return refuseSrf(doc, 'analyze_draft', 'SRF_NOT_ANALYSABLE', `"${id}" is a curve: it has no faces`, [id], ['id']);
    if (!(len3(pullDirection as Vec3) > 0)) return invalid('pullDirection must be non-zero', 'pullDirection');
    if (!(minDraftDeg >= -90 && minDraftDeg <= 90))
      return invalid(`minDraftDeg must be within -90..90 (got ${minDraftDeg})`, 'minDraftDeg');
    if (!(Number.isInteger(grid) && grid >= 2 && grid <= MAX_GRID))
      return invalid(`grid must be an integer in 2..${MAX_GRID} (got ${grid})`, 'grid');
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const solid = target.shape;
    if (solid.type === 'points') return invalid('a point cloud has no faces', 'id');
    const shape =
      solid.type === 'surface'
        ? { type: 'surface' as const, surface: solid.surface }
        : { type: 'mesh' as const, triangles: solid.triangles };
    const result = engine.draft({ shape, pull: pullDirection as Vec3, minDraftDeg, grid, flip: target.shape.type === 'surface' && flip });
    if (result.samples.length === 0) return invalid(`"${id}" has no faces to measure`, 'id');
    const stride = Math.max(1, Math.ceil(result.samples.length / 2_000));
    const listed = result.samples
      .filter((_, index) => index % stride === 0)
      .map((s) => ({ point: sigVec(s.point), draftDeg: sig(s.draftDeg), area: sig(s.area) }));
    const fraction = result.totalArea > 0 ? result.areaBelowMin / result.totalArea : 0;
    const pass = result.areaBelowMin === 0;
    const data = {
      id,
      source: target.shape.type === 'surface' ? 'nurbs_surface grid' : 'tessellated solid',
      pullDirection: [...pullDirection],
      minDraftDeg,
      sampleCount: result.samples.length,
      samples: listed,
      minDeg: sig(result.minDeg),
      maxDeg: sig(result.maxDeg),
      totalArea: sig(result.totalArea),
      areaBelowMin: sig(result.areaBelowMin),
      areaBelowMinFraction: sig(fraction),
      undercutArea: sig(result.undercutArea),
      undercut: result.undercutArea > 0,
      pass,
      unit: doc.units,
      areaUnit: `${doc.units}^2`,
      engine: engine.provenance.engine,
      unverified: false,
      provenance: {
        method: 'draft = asin(n . pull) per facet (solids) or per patch cell (sheets); facet normals approximate curved faces',
        reference: 'standard mould-draft definition; 02 SRF FR-24',
        inputs: { id, pullDirection, minDraftDeg },
      },
    };
    return report(
      doc,
      `analyze_draft ${id}: draft ${data.minDeg}..${data.maxDeg} deg over ${data.totalArea} ${doc.units}^2; ${data.areaBelowMin} ${doc.units}^2 (${sig(fraction * 100)}%) below ${minDraftDeg} deg, ` +
        `undercut ${data.undercutArea} ${doc.units}^2 -> ${pass ? 'PASS' : 'FAIL'}.`,
      data,
    );
  },
});
