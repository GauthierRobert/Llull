/** fit_surface_to_mesh — one least-squares B-spline patch through a region of a mesh (07 MSH FR-MSH-24, M6). */

import { cross3, dot3, sub3 } from '../../lib/vec3';
import { MAX_SURFACE_POLES } from '../../lib/nurbs/surfaceTypes';
import { type PatchFit, footPoints, fitPatch, regionFrame } from '../../geometry/mesh/surfaceLsq';
import { type HarmonicMap, harmonicMap, parameterStretch } from '../../geometry/mesh/harmonicMap';
import type { Vec3 } from '../../model/types';
import { colorField, defineCommand, layerIdField, nameField, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { DEFAULT_SURFACE_COLOR, commitSurface } from '../surface/surfaceShared';
import { contextOf, isLoadFailure, loadSolidMesh, meshRejection, namedDefault, withConventions } from './meshCommon';

const DEFAULT_DEGREE = 3;
const DEFAULT_SMOOTHING = 1e-3;
const MAX_CONTROL_POINTS = 60;
const MAX_ROUNDS = 6;
/** Most vertices the least-squares solve uses (strided); the deviation is measured on up to MAX_MEASURED points. */
const MAX_FIT_VERTICES = 15_000;
const MAX_MEASURED = 30_000;
/** Most triangles in the region (a region is strided to MAX_FIT_VERTICES for the solve, but its measurement and area pass are linear in it). */
const MAX_REGION_TRIANGLES = 200_000;
/** A region this folded (area fraction of triangles at or past vertical against its best-fit plane) cannot be one patch. */
const MAX_FOLDED_FRACTION = 0.02;
/** Pole counts tried, longest side, when maxDeviation drives the size. */
const AUTO_LONG_SIDES = [6, 8, 12, 16, 24, 32, 40];
/** Samples needed per pole for the fit to be determined by the data. */
const SAMPLES_PER_POLE = 2;

const PARAMETERIZATIONS = ['auto', 'projection', 'harmonic'] as const;

/** Mean of parameter pairs. */
const meanUv = (uvs: ReadonlyArray<[number, number]>): [number, number] => [
  uvs.reduce((sum, uv) => sum + uv[0], 0) / uvs.length,
  uvs.reduce((sum, uv) => sum + uv[1], 0) / uvs.length,
];

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * @affects creates 1 nurbs_surface entity (poles in world coordinates, position zero); the mesh is not touched
 * @invariant a clamped uniform tensor-product B-spline of one degree; the parameters are the orthogonal projection onto the best-fit plane of the region, or the harmonic map of a disk region onto the unit square (data.parameterization); the surface normal (du x dv) faces the side the mesh triangles face; data.maxDeviation is the largest distance from region vertices, edge midpoints and triangle centres to the patch (a lower bound of the Hausdorff distance) (the patch may extend past a non-rectangular region)
 * @failure unknown id / not a solid -> MESH_*; region without triangles, over the region cap, folded against its best-fit plane (projection) or not a disk (harmonic) or its map folded, or too few samples for the pole grid -> MESH_FIT_*; degree/pole grid out of range -> MESH_PARAM_INVALID; maxDeviation not reached -> surface created, warning MESH_FIT_NOT_CONVERGED in data.warnings
 */
export const fitSurfaceToMesh = defineCommand({
  name: 'fit_surface_to_mesh',
  description:
    'Fit ONE tensor-product B-spline surface (a nurbs_surface sheet) to a mesh, or to the part of it inside a sphere `region`. `parameterization` ' +
    '"projection" projects the region orthogonally onto its best-fit plane (it must look like a height field over that plane: gently curved, ' +
    'not folded back); "harmonic" maps a DISK-topology region (one connected manifold piece with exactly one boundary loop) onto the unit square ' +
    'by the harmonic map (cotangent Laplacian solved by conjugate gradient to 1e-10, boundary by arc length, corners at the quarter points of its length; weights ' +
    'clamped positive when the exact ones flip a triangle), which follows a strongly curved region (a hemisphere, a bowl) that projection ' +
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
    'MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_FIT_REGION_EMPTY, MESH_FIT_NOT_DISK (harmonic: not a disk; the reason is named), MESH_FIT_PARAM_FOLDED (harmonic: the map did not converge or a triangle stays flipped), MESH_FIT_TOO_LARGE (a region of over ' +
    `${MAX_REGION_TRIANGLES} triangles: pick a smaller region or decimate_mesh first), MESH_FIT_NOT_PROJECTABLE, MESH_FIT_TOO_FEW_SAMPLES, ` +
    'MESH_FIT_FAILED.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid, tessellated) to fit.'),
    region: z
      .object({
        center: vec3('Centre [x, y, z] of the sphere (document units, world).'),
        radius: z.number().positive().describe('Radius of the sphere (document units).'),
      })
      .optional()
      .describe('Fit only the triangles whose centre lies inside this sphere. Default: the whole mesh.'),
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
    const { id, region } = params;
    const degree = params.degree ?? DEFAULT_DEGREE;
    const smoothing = params.smoothing ?? DEFAULT_SMOOTHING;
    const fail = (code: string, message: string, path?: string): CommandResult =>
      meshRejection(doc, 'fit_surface_to_mesh', code, message, [id], path !== undefined ? [`params.${path}`] : []);
    if (params.controlPoints !== undefined && params.controlPoints.some((count) => count < degree + 1))
      return fail('MESH_PARAM_INVALID', `controlPoints needs at least degree + 1 = ${degree + 1} poles per direction`, 'controlPoints');
    const loaded = loadSolidMesh(doc, id, undefined, contextOf(ctx).meshAssets);
    if (isLoadFailure(loaded)) return meshRejection(doc, 'fit_surface_to_mesh', loaded.code, loaded.message, loaded.ids);
    const { mesh } = loaded;
    const triangles = mesh.indices.length / 3;
    const vertex = (v: number): Vec3 => [
      mesh.positions[3 * v] as number,
      mesh.positions[3 * v + 1] as number,
      mesh.positions[3 * v + 2] as number,
    ];
    const faces: number[] = [];
    for (let f = 0; f < triangles; f++) {
      if (region !== undefined) {
        const [a, b, c] = [
          vertex(mesh.indices[3 * f] as number),
          vertex(mesh.indices[3 * f + 1] as number),
          vertex(mesh.indices[3 * f + 2] as number),
        ];
        const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        if (Math.hypot(centre[0] - region.center[0], centre[1] - region.center[1], centre[2] - region.center[2]) > region.radius) continue;
      }
      faces.push(f);
    }
    if (faces.length === 0) return fail('MESH_FIT_REGION_EMPTY', 'no triangle centre lies inside the region', 'region');
    if (faces.length > MAX_REGION_TRIANGLES)
      return fail(
        'MESH_FIT_TOO_LARGE',
        `the region holds ${faces.length} triangles (max ${MAX_REGION_TRIANGLES}); pick a smaller region or decimate_mesh first`,
        'region',
      );
    const framed = regionFrame(mesh, faces);
    if (framed === null) return fail('MESH_FIT_REGION_EMPTY', 'the region has no area or no best-fit plane', 'region');
    const wanted = params.parameterization ?? 'auto';
    const foldedText = `${(100 * framed.foldedFraction).toFixed(1)} % of the region's area folds back or stands vertical against its best-fit plane (limit ${100 * MAX_FOLDED_FRACTION} %)`;
    const projectable = framed.foldedFraction <= MAX_FOLDED_FRACTION;
    let harmonic: HarmonicMap | null = null;
    if (wanted === 'harmonic' || (wanted === 'auto' && !projectable)) {
      const mapped = harmonicMap(mesh, faces);
      if ('code' in mapped)
        return wanted === 'auto' && mapped.code === 'MESH_FIT_NOT_DISK'
          ? fail('MESH_FIT_NOT_PROJECTABLE', `${foldedText}, and the harmonic map needs a disk: ${mapped.message}`, 'region')
          : fail(mapped.code, mapped.message, 'region');
      harmonic = mapped;
    } else if (!projectable) return fail('MESH_FIT_NOT_PROJECTABLE', foldedText, 'region');
    const { frame } = framed;
    const hv = (v: number): [number, number] => (harmonic as HarmonicMap).uv.get(v) as [number, number];
    const planar = (p: Vec3): [number, number] => {
      const d = sub3(p, frame.origin);
      return [dot3(d, frame.uAxis), dot3(d, frame.vAxis)];
    };
    const vertexWeight = new Map<number, number>();
    const measured: Vec3[] = [];
    const measuredUv: Array<[number, number]> = [];
    const seenEdges = new Set<number>();
    const vertexCount = mesh.positions.length / 3;
    for (const f of faces) {
      const corners = [0, 1, 2].map((k) => mesh.indices[3 * f + k] as number);
      const [a, b, c] = corners.map(vertex) as [Vec3, Vec3, Vec3];
      const area = Math.hypot(...cross3(sub3(b, a), sub3(c, a))) / 2;
      for (const v of corners) vertexWeight.set(v, (vertexWeight.get(v) ?? 0) + area / 3);
      measured.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
      if (harmonic !== null) measuredUv.push(meanUv(corners.map(hv)));
      corners.forEach((v, k) => {
        const w = corners[(k + 1) % 3] as number;
        const key = Math.min(v, w) * vertexCount + Math.max(v, w);
        if (seenEdges.has(key)) return;
        seenEdges.add(key);
        const [p, q] = [vertex(v), vertex(w)];
        measured.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]);
        if (harmonic !== null) measuredUv.push(meanUv([hv(v), hv(w)]));
      });
    }
    const used = [...vertexWeight.keys()].sort((x, y) => x - y);
    const stride = Math.max(1, Math.ceil(used.length / MAX_FIT_VERTICES));
    const picked = used.filter((_, i) => i % stride === 0);
    const points = picked.map(vertex);
    const total = picked.reduce((sum, v) => sum + (vertexWeight.get(v) as number), 0);
    const weights = picked.map((v) => (vertexWeight.get(v) as number) / total);
    const bounds =
      harmonic !== null
        ? { s0: 0, s1: 1, t0: 0, t1: 1 }
        : used.map(vertex).reduce(
            (box, p) => {
              const [s, t] = planar(p);
              return { s0: Math.min(box.s0, s), s1: Math.max(box.s1, s), t0: Math.min(box.t0, t), t1: Math.max(box.t1, t) };
            },
            { s0: Infinity, s1: -Infinity, t0: Infinity, t1: -Infinity },
          );
    const [spanS, spanT] = [bounds.s1 - bounds.s0, bounds.t1 - bounds.t0];
    if (!(spanS > 0 && spanT > 0)) return fail('MESH_FIT_REGION_EMPTY', 'the region is degenerate in its best-fit plane', 'region');
    const uvOf = (p: Vec3): [number, number] => {
      const [s, t] = planar(p);
      return [(s - bounds.s0) / spanS, (t - bounds.t0) / spanT];
    };
    const stretch = harmonic === null ? null : parameterStretch(mesh, faces, harmonic.uv);
    const swapped = stretch === null ? spanT > spanS : stretch.v > stretch.u;
    const orientUv = ([u, v]: [number, number]): [number, number] => (swapped ? [v, 1 - u] : [u, v]);
    const orient = (p: Vec3): [number, number] => orientUv(uvOf(p));
    const [longSpan, shortSpan] =
      stretch !== null ? [Math.max(stretch.u, stretch.v), Math.min(stretch.u, stretch.v)] : swapped ? [spanT, spanS] : [spanS, spanT];
    const fitUv = harmonic !== null ? picked.map((v) => orientUv(hv(v))) : points.map(orient);
    const sizes: Array<[number, number]> =
      params.controlPoints !== undefined
        ? [params.controlPoints]
        : (params.maxDeviation !== undefined
            ? AUTO_LONG_SIDES
            : [Math.min(16, Math.max(degree + 1, Math.round(Math.sqrt(points.length) / 3)))]
          ).map((long): [number, number] => [
            Math.max(degree + 1, long),
            Math.min(Math.max(degree + 1, Math.round((long * shortSpan) / longSpan)), MAX_CONTROL_POINTS),
          ]);
    const fitted: Array<{ fit: PatchFit; size: [number, number] }> = [];
    for (const size of sizes) {
      if (size[0] > MAX_SURFACE_POLES || size[1] > MAX_SURFACE_POLES) break;
      if (points.length < SAMPLES_PER_POLE * size[0] * size[1]) {
        if (fitted.length === 0)
          return fail(
            'MESH_FIT_TOO_FEW_SAMPLES',
            `${points.length} region vertices cannot determine a ${size[0]} x ${size[1]} pole grid (need ${SAMPLES_PER_POLE} per pole)`,
            'controlPoints',
          );
        break;
      }
      const fit = fitPatch(points, weights, fitUv, {
        degree,
        countU: size[0],
        countV: size[1],
        smoothing,
        rounds: MAX_ROUNDS,
        tolerance: params.maxDeviation,
      });
      if (fit === null) return fail('MESH_FIT_FAILED', 'the least-squares solve produced non-finite poles');
      fitted.push({ fit, size });
      if (params.maxDeviation !== undefined && fit.stats.max <= params.maxDeviation) break;
    }
    const last = fitted[fitted.length - 1] as { fit: PatchFit; size: [number, number] };
    const stride2 = Math.max(1, Math.ceil((used.length + measured.length) / MAX_MEASURED));
    const everything = [...used.map(vertex), ...measured].filter((_, i) => i % stride2 === 0);
    const everythingUv =
      harmonic !== null
        ? [...used.map((v) => orientUv(hv(v))), ...measuredUv.map(orientUv)].filter((_, i) => i % stride2 === 0)
        : everything.map(orient);
    const check = footPoints(last.fit.surface, everything, everythingUv);
    const converged = params.maxDeviation === undefined || check.stats.max <= params.maxDeviation;
    const unit = doc.units;
    const rounded = {
      ...last.fit.surface,
      poles: last.fit.surface.poles.map((row) => row.map((p): Vec3 => [round6(p[0]), round6(p[1]), round6(p[2])])),
    };
    const defaults = [
      ...(params.degree === undefined ? [namedDefault('degree', DEFAULT_DEGREE, '1', 'FR-MSH-24 default')] : []),
      ...(params.smoothing === undefined ? [namedDefault('smoothing', DEFAULT_SMOOTHING, '1', 'TECHNICAL_SPEC 5.9')] : []),
    ];
    const committed = commitSurface(
      doc,
      rounded,
      { color: params.color, layerId: params.layerId, name: params.name },
      (surfaceId) =>
        `fit_surface_to_mesh '${id}' -> '${surfaceId}': degree ${degree}, ${last.size[0]} x ${last.size[1]} poles from ${points.length} of ${used.length} region vertices, ` +
        `max deviation ${check.stats.max.toPrecision(3)} ${unit} (rms ${check.stats.rms.toPrecision(3)}) in ${last.fit.rounds} round(s)${converged ? '' : `, NOT within ${params.maxDeviation} ${unit}`}.`,
    );
    const surfaceId = committed.affected[0] as string;
    return {
      ...committed,
      data: withConventions(
        doc,
        {
          id: surfaceId,
          sourceId: id,
          degree,
          controlPoints: last.size,
          regionTriangles: faces.length,
          regionArea: framed.area,
          fitVertices: points.length,
          measuredPoints: everything.length,
          rounds: last.fit.rounds,
          stalled: last.fit.stalled,
          gridsTried: fitted.map((f) => f.size),
          maxDeviation: check.stats.max,
          mean: check.stats.mean,
          rms: check.stats.rms,
          worst: check.stats.worst,
          requestedMaxDeviation: params.maxDeviation ?? null,
          converged,
          foldedFraction: framed.foldedFraction,
          smoothing,
          parameterization:
            harmonic === null
              ? { method: 'projection' }
              : {
                  method: 'harmonic',
                  weights: harmonic.weights,
                  flippedWithExactWeights: harmonic.flippedFirst,
                  collapsedTriangles: harmonic.collapsedInParameters,
                  interiorVertices: harmonic.interiorVertices,
                  boundaryVertices: harmonic.boundaryVertices,
                  cgIterations: harmonic.cgIterations,
                  cgResidual: harmonic.cgResidual,
                },
          frame:
            harmonic === null
              ? { origin: frame.origin, uAxis: frame.uAxis, vAxis: frame.vAxis, normal: frame.normal, longAxis: swapped ? 'v' : 'u' }
              : null,
          warnings: converged
            ? []
            : [
                {
                  code: 'MESH_FIT_NOT_CONVERGED',
                  message: `largest distance ${check.stats.max.toPrecision(4)} ${unit} > ${params.maxDeviation} with the largest grid tried (${last.size[0]} x ${last.size[1]}); the surface was still created`,
                },
              ],
        },
        { unverified: loaded.unverified, defaults },
      ),
    };
  },
});
