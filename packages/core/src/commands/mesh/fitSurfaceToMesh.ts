/** fit_surface_to_mesh — one least-squares B-spline patch through a region of a mesh (07 MSH FR-MSH-24, M6). */

import { colorField, defineCommand, layerIdField, nameField, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { DEFAULT_SURFACE_COLOR } from '../surface/surfaceShared';
import { faceGroupsParam } from './faceGroupRegion';
import { contextOf, isLoadFailure, loadSolidMesh, meshRejection } from './meshCommon';
import {
  DEFAULT_DEGREE,
  DEFAULT_SMOOTHING,
  MAX_CONTROL_POINTS,
  MAX_REGION_TRIANGLES,
  PARAMETERIZATIONS,
  controlPointsRefusal,
  runFit,
} from './fitSurfaceRun';

/**
 * @affects creates 1 nurbs_surface entity (poles in world coordinates, position zero); the mesh is not touched
 * @invariant a clamped uniform tensor-product B-spline of one degree; the parameters are the orthogonal projection onto the best-fit plane of the region, or the harmonic map of a disk region onto the unit square (data.parameterization); the surface normal (du x dv) faces the side the mesh triangles face; data.maxDeviation is the largest distance from region vertices, edge midpoints and triangle centres to the patch (a lower bound of the Hausdorff distance) (the patch may extend past a non-rectangular region)
 * @failure unknown id / not a solid -> MESH_*; a faceGroups name or segment id that does not exist, or a stale stored group -> MESH_FIT_GROUP_NOT_FOUND; region without triangles, over the region cap, folded against its best-fit plane (projection) or not a disk (harmonic) or its map folded, or too few samples for the pole grid -> MESH_FIT_*; degree/pole grid out of range -> MESH_PARAM_INVALID; maxDeviation not reached -> surface created, warning MESH_FIT_NOT_CONVERGED in data.warnings
 */
export const fitSurfaceToMesh = defineCommand({
  name: 'fit_surface_to_mesh',
  description:
    'Fit ONE tensor-product B-spline surface (a nurbs_surface sheet) to a mesh, or to the part of it inside a sphere `region` and/or in `faceGroups` (named groups of the mesh or segment_mesh regions). `parameterization` ' +
    '"projection" projects the region orthogonally onto its best-fit plane (it must look like a height field over that plane: gently curved, ' +
    'not folded back); "harmonic" maps a DISK-topology region (one connected manifold piece with exactly one boundary loop) onto the unit square ' +
    'by the harmonic map (cotangent Laplacian solved by conjugate gradient to 1e-9 within an iteration budget, boundary by arc length between four corner vertices: the sharpest turns, else the vertices nearest the quarter points of its length; Floater mean-value weights when the exact ones flip a triangle; at most 25,000 triangles in the TypeScript engine, up to the cap of the native engine (a background job) on the desktop and the CLI), which follows a strongly curved region (a hemisphere, a bowl) that projection ' +
    'refuses; "auto" (default) uses projection when the region is projectable and the harmonic map otherwise. A closed body, a region with holes or in ' +
    'several pieces, or a vertical wall is refused (MESH_FIT_NOT_PROJECTABLE / MESH_FIT_NOT_DISK: pick a `region` or segment_mesh first). Rounds of ' +
    'least-squares pole fitting alternate with foot-point parameter correction, with a small second-difference fairing of the pole ' +
    'grid (`smoothing`). Give `controlPoints` [nu, nv] for a fixed grid (u runs along the long axis of the region), or give only ' +
    '`maxDeviation` and the grid grows (6 up to 40 poles on the long side) until the patch is within it; with neither, a grid is chosen ' +
    'from the mesh density (at most 16 poles on the long side). `degree` 1..5 (default 3) in both directions. The surface is created in ' +
    'world coordinates with its normal on the side the triangles face; the mesh is kept. data.maxDeviation, data.rms and data.mean are ' +
    "distances from the region's vertices, edge midpoints and triangle centres to the patch (document units; a lower bound of the " +
    'Hausdorff distance, tight for a fine mesh); the patch covers the bounding rectangle of ' +
    'the region in its plane, so parts of it past a non-rectangular region are not measured. If `maxDeviation` is given and not reached ' +
    'the surface is still created and data.warnings holds MESH_FIT_NOT_CONVERGED. Pure TypeScript, no kernel. Refusals: ' +
    'MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_FIT_REGION_EMPTY, MESH_FIT_GROUP_NOT_FOUND (a faceGroups name the mesh does not have, or a stale stored group), MESH_FIT_NOT_DISK (harmonic: not a disk; the reason is named), MESH_FIT_PARAM_FOLDED (harmonic: the map did not converge within its iteration budget or a triangle stays flipped), MESH_FIT_TOO_LARGE (a region of over ' +
    `${MAX_REGION_TRIANGLES} triangles, 25,000 in the TypeScript engine (more with the native engine) for the harmonic map: pick a smaller region or decimate_mesh first), MESH_FIT_NOT_PROJECTABLE, MESH_FIT_TOO_FEW_SAMPLES, ` +
    'MESH_FIT_FAILED. From a faceGroups selection the segmentation refusals pass through: MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_SEGMENT_NO_GROUPS, MESH_ENGINE_CAP_EXCEEDED; ' +
    'from the mesh load MESH_ASSET_MISSING / MESH_ASSET_UNAVAILABLE.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid, tessellated) to fit.'),
    region: z
      .object({
        center: vec3('Centre [x, y, z] of the sphere (document units, world).'),
        radius: z.number().positive().describe('Radius of the sphere (document units).'),
      })
      .optional()
      .describe('Fit only the triangles whose centre lies inside this sphere. Default: the whole mesh.'),
    faceGroups: faceGroupsParam
      .optional()
      .describe(
        'Fit only the triangles of these face groups: `stored` names groups of the mesh, `segments` ids of segment_mesh regions (the same featureAngleDeg / fitTolerance / kinds). With `region` too, the triangles in both. A group is a natural disk for parameterization "harmonic".',
      ),
    parameterization: z
      .enum(PARAMETERIZATIONS)
      .optional()
      .describe(
        '"auto" (default): projection for a projectable region, the harmonic map for a disk that is not; "projection"; "harmonic" (a disk region only).',
      ),
    degree: z.number().int().min(1).max(5).optional().describe(`Degree of the surface in u and v, 1..5 (default ${DEFAULT_DEGREE}).`),
    controlPoints: z
      .tuple([z.number().int().min(2).max(MAX_CONTROL_POINTS), z.number().int().min(2).max(MAX_CONTROL_POINTS)])
      .optional()
      .describe(
        `Pole grid [nu, nv], each degree + 1 .. ${MAX_CONTROL_POINTS}; u runs along the long axis of the region. Omit to choose it (see maxDeviation).`,
      ),
    maxDeviation: z
      .number()
      .positive()
      .optional()
      .describe(
        'Wanted largest distance from the mesh region to the patch (document units). Without controlPoints it grows the grid until met.',
      ),
    smoothing: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        `Weight of the second-difference fairing of the pole grid, 0..1 (default ${DEFAULT_SMOOTHING}). Raise it for a noisy mesh.`,
      ),
    color: colorField(DEFAULT_SURFACE_COLOR),
    layerId: layerIdField(),
    name: nameField(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = controlPointsRefusal(doc, params);
    if (refused !== null) return refused;
    const loaded = loadSolidMesh(doc, params.id, undefined, contextOf(ctx).meshAssets);
    if (isLoadFailure(loaded)) return meshRejection(doc, 'fit_surface_to_mesh', loaded.code, loaded.message, loaded.ids);
    return runFit(doc, ctx, loaded, params);
  },
});
