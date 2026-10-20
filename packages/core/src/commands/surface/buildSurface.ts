/** create_nurbs_surface and surface_from_points: the two ways to make a `nurbs_surface` from numbers. */

import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { clampedUniformKnots, compressKnots } from '../../lib/nurbs/knotVector';
import { interpolateGrid } from '../../lib/nurbs/surfaceFit';
import { surfaceViolation, MAX_SURFACE_POLES, type NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { refuseSrf } from './shared';
import { commitSurface, sig, surfaceStyleFields } from './surfaceShared';

const layoutOf = (
  count: number,
  degree: number,
  knots: ReadonlyArray<number> | undefined,
  multiplicities: ReadonlyArray<number> | undefined,
): { knots: number[]; multiplicities: number[] } =>
  knots === undefined
    ? clampedUniformKnots(count, degree)
    : multiplicities !== undefined
      ? { knots: [...knots], multiplicities: [...multiplicities] }
      : compressKnots(knots);

/**
 * @affects creates 1 nurbs_surface entity
 * @invariant clamped tensor-product patch; every pole row has the same length; weights have the shape of poles and are > 0
 * @failure bad degrees, ragged grid, bad knots / multiplicities / weights -> SRF_NURBS_INVALID, no-op
 */
export const createNurbsSurface = defineCommand({
  name: 'create_nurbs_surface',
  description:
    'Create a NURBS surface sheet (clamped tensor-product B-spline patch, optionally rational) from its control net. `poles` is a grid ' +
    '[i][j] of control points: i runs along u (the outer array), j along v (each inner array), all inner arrays the same length. `degreeU` / ' +
    '`degreeV` 1..25 (3 = bicubic), each direction needs at least degree + 1 poles. Omit the knots for clamped uniform vectors on [0, 1]; ' +
    'to give them, pass the full knot vector (`knotsU` / `knotsV` alone) or the distinct knots with `multiplicitiesU` / `multiplicitiesV`. ' +
    '`weights` (a grid like `poles`, every value > 0) make it rational (spheres, cylinders, tori are exact rational patches). The patch ' +
    'is a sheet: it has area but no volume. Next: inspect_nurbs, analyze_surface_curvature, check_continuity, thicken_surface.',
  params: z.object({
    degreeU: z.number().describe('Degree along u, an integer 1..25.'),
    degreeV: z.number().describe('Degree along v, an integer 1..25.'),
    poles: z
      .array(z.array(vec3('Control point [x, y, z] in document units, relative to `position`.')))
      .describe('Control net: poles[i][j], i along u, j along v; a rectangular grid of at least 2 x 2.'),
    weights: z
      .array(z.array(z.number()))
      .describe('Optional rational weights, a grid with the shape of `poles`, every value finite and > 0.')
      .optional(),
    knotsU: z
      .array(z.number())
      .describe('Optional u knots: the full non-decreasing vector, or the distinct knots when `multiplicitiesU` is given.')
      .optional(),
    multiplicitiesU: z.array(z.number()).describe('Optional multiplicity of each distinct u knot (ends degreeU + 1).').optional(),
    knotsV: z
      .array(z.number())
      .describe('Optional v knots: the full non-decreasing vector, or the distinct knots when `multiplicitiesV` is given.')
      .optional(),
    multiplicitiesV: z.array(z.number()).describe('Optional multiplicity of each distinct v knot (ends degreeV + 1).').optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { degreeU, degreeV, poles, weights } = params;
    const refuse = (path: string, message: string): CommandResult =>
      refuseSrf(doc, 'create_nurbs_surface', 'SRF_NURBS_INVALID', message, [], [`params.${path}`]);
    const countV = poles[0]?.length ?? 0;
    if (poles.length > MAX_SURFACE_POLES || countV > MAX_SURFACE_POLES)
      return refuse('poles', `at most ${MAX_SURFACE_POLES} poles per direction`);
    if (!Number.isInteger(degreeU) || !Number.isInteger(degreeV) || degreeU < 1 || degreeV < 1 || degreeU > 25 || degreeV > 25)
      return refuse('degreeU', `degrees must be integers in 1..25 (got ${degreeU}, ${degreeV})`);
    const u = layoutOf(poles.length, degreeU, params.knotsU, params.multiplicitiesU);
    const v = layoutOf(countV, degreeV, params.knotsV, params.multiplicitiesV);
    const surface: NurbsSurfaceData = {
      degreeU,
      degreeV,
      poles,
      ...(weights === undefined ? {} : { weights }),
      knotsU: u.knots,
      multiplicitiesU: u.multiplicities,
      knotsV: v.knots,
      multiplicitiesV: v.multiplicities,
    };
    const violation = surfaceViolation(surface);
    if (violation !== null) return refuse(violation.path, violation.message);
    return commitSurface(
      doc,
      surface,
      params,
      (id) =>
        `create_nurbs_surface: created ${weights === undefined ? 'non-rational' : 'rational'} ${degreeU}x${degreeV} surface "${id}" with ${poles.length} x ${countV} poles.`,
    );
  },
});

/**
 * @affects creates 1 nurbs_surface entity through every grid point
 * @invariant global tensor-product interpolation (A9.4) at averaged chord-length parameters; the residual at the grid points is reported
 * @failure ragged grid or too few points -> SRF_POINTS_INSUFFICIENT; bad degree -> SRF_NURBS_INVALID, no-op
 */
export const surfaceFromPoints = defineCommand({
  name: 'surface_from_points',
  description:
    'Create a NURBS surface sheet that passes exactly through a grid of points (global bicubic interpolation by default). `grid[i][j]` are ' +
    'points with i along u (outer array) and j along v, all rows the same length, at least degree + 1 in each direction; neighbouring ' +
    'points must be distinct. `degreeU` / `degreeV` default 3 (lowered automatically when the grid is smaller; 1..5). `mode` "interpolate" ' +
    '(default) fits the surface through the points; "control_net" uses the points as the control net instead (the surface then approximates ' +
    'them). Approximation to a tolerance is not available. Returns the surface id and the interpolation residual (round-off level). ' +
    'Next: analyze_surface_curvature, measure_deviation.',
  params: z.object({
    grid: z
      .array(z.array(vec3('Point [x, y, z] in document units, relative to `position`.')))
      .describe('Point grid grid[i][j], i along u, j along v; at most 200 x 200.'),
    mode: z
      .enum(['interpolate', 'control_net'])
      .describe('"interpolate" (default): pass through the points. "control_net": use them as poles.')
      .optional(),
    degreeU: z.number().describe('Degree along u, integer 1..5. Default 3 (capped by the number of rows - 1).').optional(),
    degreeV: z.number().describe('Degree along v, integer 1..5. Default 3 (capped by the number of columns - 1).').optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { grid, mode = 'interpolate' } = params;
    const refuse = (code: string, message: string, path: string): CommandResult =>
      refuseSrf(doc, 'surface_from_points', code, message, [], [`params.${path}`]);
    const countV = grid[0]?.length ?? 0;
    if (grid.length > 200 || countV > 200) return refuse('SRF_POINTS_INSUFFICIENT', 'at most 200 x 200 points', 'grid');
    if (grid.some((row) => row.length !== countV))
      return refuse('SRF_POINTS_INSUFFICIENT', 'every grid row needs the same number of points', 'grid');
    if (grid.length < 2 || countV < 2) return refuse('SRF_POINTS_INSUFFICIENT', 'a surface needs at least 2 x 2 points', 'grid');
    const degreeU = Math.min(params.degreeU ?? 3, grid.length - 1);
    const degreeV = Math.min(params.degreeV ?? 3, countV - 1);
    if (mode === 'control_net') {
      const [layoutU, layoutV] = [clampedUniformKnots(grid.length, degreeU), clampedUniformKnots(countV, degreeV)];
      const surface: NurbsSurfaceData = {
        degreeU,
        degreeV,
        poles: grid,
        knotsU: layoutU.knots,
        multiplicitiesU: layoutU.multiplicities,
        knotsV: layoutV.knots,
        multiplicitiesV: layoutV.multiplicities,
      };
      const violation = surfaceViolation(surface);
      if (violation !== null) return refuse('SRF_POINTS_INSUFFICIENT', violation.message, 'grid');
      return commitSurface(
        doc,
        surface,
        params,
        (id) =>
          `surface_from_points: created ${degreeU}x${degreeV} surface "${id}" with the ${grid.length} x ${countV} points as control net.`,
      );
    }
    const fit = interpolateGrid(grid, degreeU, degreeV);
    if ('code' in fit) return refuse(fit.code, fit.message, fit.code === 'SRF_NURBS_INVALID' ? 'degreeU' : 'grid');
    return commitSurface(
      doc,
      fit.surface,
      params,
      (id) =>
        `surface_from_points: created ${degreeU}x${degreeV} surface "${id}" through ${grid.length} x ${countV} points (max residual ${sig(fit.residual)} ${doc.units}).`,
    );
  },
});
