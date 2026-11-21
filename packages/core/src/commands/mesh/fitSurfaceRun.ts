/** Run phases of fit_surface_to_mesh (07 MSH FR-MSH-24): region selection, parameterization, sampling, grid fitting and the committed result. */

import { cross3, dot3, hypot3, sub3 } from '../../lib/vec3';
import { MAX_SURFACE_POLES } from '../../lib/nurbs/surfaceTypes';
import { type PatchFit, type RegionFrame, footPoints, fitPatch, regionFrame } from '../../geometry/mesh/surfaceLsq';
import { type HarmonicMap, parameterStretch } from '../../geometry/mesh/harmonicMap';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import type { CadDocument, MeshData, Vec3 } from '../../model/types';
import type { z } from '../schema';
import type { CommandResult, ExecutionContext } from '../types';
import { commitSurface } from '../surface/surfaceShared';
import { faceGroupSelection, type faceGroupsParam } from './faceGroupRegion';
import { type SolidMesh, contextOf, meshRejection, namedDefault, withConventions } from './meshCommon';
import { isRegionRefusal, regionHarmonic } from './harmonicRegion';

export const DEFAULT_DEGREE = 3;
export const DEFAULT_SMOOTHING = 1e-3;
export const MAX_CONTROL_POINTS = 60;
const MAX_ROUNDS = 6;
/** Most vertices the least-squares solve uses (strided); the deviation is measured on up to MAX_MEASURED points. */
const MAX_FIT_VERTICES = 15_000;
const MAX_MEASURED = 30_000;
/** Most triangles in the region (a region is strided to MAX_FIT_VERTICES for the solve, but its measurement and area pass are linear in it). */
export const MAX_REGION_TRIANGLES = 200_000;
/** A region this folded (area fraction of triangles at or past vertical against its best-fit plane) cannot be one patch. */
const MAX_FOLDED_FRACTION = 0.02;
/** Pole counts tried, longest side, when maxDeviation drives the size. */
const AUTO_LONG_SIDES = [6, 8, 12, 16, 24, 32, 40];
/** Samples needed per pole for the fit to be determined by the data. */
const SAMPLES_PER_POLE = 2;

export const PARAMETERIZATIONS = ['auto', 'projection', 'harmonic'] as const;

/** Mean of parameter pairs. */
const meanUv = (uvs: ReadonlyArray<[number, number]>): [number, number] => [
  uvs.reduce((sum, uv) => sum + uv[0], 0) / uvs.length,
  uvs.reduce((sum, uv) => sum + uv[1], 0) / uvs.length,
];

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

type Fail = (code: string, message: string, path?: string) => CommandResult;
type Uv = [number, number];
type Grid = [number, number];

interface FitRegion {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

interface FitOptions {
  readonly degree?: number | undefined;
  readonly smoothing?: number | undefined;
  readonly controlPoints?: Grid | undefined;
  readonly maxDeviation?: number | undefined;
  readonly color?: string | undefined;
  readonly layerId?: string | undefined;
  readonly name?: string | undefined;
}

const vertexReader =
  (mesh: MeshData) =>
  (v: number): Vec3 => [mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number];

const harmonicUv =
  (harmonic: HarmonicMap | null) =>
  (v: number): Uv =>
    (harmonic as HarmonicMap).uv.get(v) as Uv;

interface RegionSelection {
  readonly faces: number[];
  readonly groups: { stored: number; segments: number } | null;
  readonly groupFaces: Set<number> | null;
}

/** The triangles of the fit: the named face groups and / or the sphere `region`, or the refusal when none or too many. */
function selectRegion(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  id: string,
  loaded: SolidMesh,
  faceGroups: z.infer<typeof faceGroupsParam> | undefined,
  region: FitRegion | undefined,
  fail: Fail,
): RegionSelection | CommandResult {
  const { mesh } = loaded;
  const triangles = mesh.indices.length / 3;
  const vertex = vertexReader(mesh);
  let groupFaces: Set<number> | null = null;
  let groups: { stored: number; segments: number } | null = null;
  if (faceGroups !== undefined) {
    const selection = faceGroupSelection(doc, ctx, 'fit_surface_to_mesh', id, loaded, faceGroups);
    if ('document' in selection) return selection;
    groupFaces = new Set(selection.faces);
    groups = { stored: selection.storedGroups, segments: selection.segmentGroups };
  }
  const faces: number[] = [];
  for (let f = 0; f < triangles; f++) {
    if (groupFaces !== null && !groupFaces.has(f)) continue;
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
  if (faces.length === 0)
    return fail(
      'MESH_FIT_REGION_EMPTY',
      groups === null
        ? 'no triangle centre lies inside the region'
        : 'no triangle of the named face groups has its centre inside the region',
      'region',
    );
  if (faces.length > MAX_REGION_TRIANGLES)
    return fail(
      'MESH_FIT_TOO_LARGE',
      `the region holds ${faces.length} triangles (max ${MAX_REGION_TRIANGLES}); pick a smaller region or decimate_mesh first`,
      'region',
    );
  return { faces, groups, groupFaces };
}

interface Parameterization {
  readonly framed: RegionFrame;
  readonly harmonic: HarmonicMap | null;
}

/** The best-fit plane of the region and, when projection does not apply or is not wanted, the harmonic map of the region; or the refusal. */
function parameterize(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  id: string,
  mesh: MeshData,
  faces: readonly number[],
  wanted: (typeof PARAMETERIZATIONS)[number],
  fail: Fail,
): Parameterization | CommandResult {
  const framed = regionFrame(mesh, faces);
  if (framed === null) return fail('MESH_FIT_REGION_EMPTY', 'the region has no area or no best-fit plane', 'region');
  const foldedText = `${(100 * framed.foldedFraction).toFixed(1)} % of the region's area folds back or stands vertical against its best-fit plane (limit ${100 * MAX_FOLDED_FRACTION} %)`;
  const projectable = framed.foldedFraction <= MAX_FOLDED_FRACTION;
  let harmonic: HarmonicMap | null = null;
  if (wanted === 'harmonic' || (wanted === 'auto' && !projectable)) {
    const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
    const harmonicCap = engine.capabilities().get('harmonic_map') ?? 0;
    if (faces.length > harmonicCap)
      return wanted === 'auto'
        ? fail(
            'MESH_FIT_NOT_PROJECTABLE',
            `${foldedText}, and the region (${faces.length} triangles) is over the ${harmonicCap} of the harmonic map: pick a smaller region or faceGroups, or decimate_mesh`,
            'region',
          )
        : fail(
            'MESH_FIT_TOO_LARGE',
            `the harmonic map takes at most ${harmonicCap} triangles, the region holds ${faces.length}: pick a smaller region or faceGroups, or decimate_mesh first`,
            'region',
          );
    const mapped = regionHarmonic(engine, mesh, faces);
    if ('code' in mapped && !isRegionRefusal(mapped)) return meshRejection(doc, 'fit_surface_to_mesh', mapped.code, mapped.message, [id]);
    if ('code' in mapped)
      return wanted === 'auto' && mapped.code === 'MESH_FIT_NOT_DISK'
        ? fail('MESH_FIT_NOT_PROJECTABLE', `${foldedText}, and the harmonic map needs a disk: ${mapped.message}`, 'region')
        : fail(mapped.code, mapped.message, 'region');
    harmonic = mapped;
  } else if (!projectable) return fail('MESH_FIT_NOT_PROJECTABLE', foldedText, 'region');
  return { framed, harmonic };
}

interface RegionSamples {
  readonly vertexWeight: Map<number, number>;
  readonly measured: Vec3[];
  readonly measuredUv: Uv[];
}

/** Area weight of each region vertex and the measuring points (triangle centres, edge midpoints) with their harmonic parameters. */
function sampleRegion(mesh: MeshData, faces: readonly number[], harmonic: HarmonicMap | null): RegionSamples {
  const vertex = vertexReader(mesh);
  const hv = harmonicUv(harmonic);
  const vertexWeight = new Map<number, number>();
  const measured: Vec3[] = [];
  const measuredUv: Uv[] = [];
  const seenEdges = new Set<number>();
  const vertexCount = mesh.positions.length / 3;
  for (const f of faces) {
    const corners = [0, 1, 2].map((k) => mesh.indices[3 * f + k] as number);
    const [a, b, c] = corners.map(vertex) as [Vec3, Vec3, Vec3];
    const area = hypot3(cross3(sub3(b, a), sub3(c, a))) / 2;
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
  return { vertexWeight, measured, measuredUv };
}

interface UvParameters {
  readonly orient: (p: Vec3) => Uv;
  readonly orientUv: (uv: Uv) => Uv;
  readonly swapped: boolean;
  readonly longSpan: number;
  readonly shortSpan: number;
  readonly fitUv: Uv[];
}

/** The oriented (u, v) of the region: the plane bounds (or the unit square of the harmonic map), the long axis along u, and the fit samples' parameters; null when degenerate. */
function parameterFrame(
  mesh: MeshData,
  faces: readonly number[],
  { framed, harmonic }: Parameterization,
  used: readonly number[],
  picked: readonly number[],
  points: readonly Vec3[],
): UvParameters | null {
  const vertex = vertexReader(mesh);
  const hv = harmonicUv(harmonic);
  const { frame } = framed;
  const planar = (p: Vec3): Uv => {
    const d = sub3(p, frame.origin);
    return [dot3(d, frame.uAxis), dot3(d, frame.vAxis)];
  };
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
  if (!(spanS > 0 && spanT > 0)) return null;
  const uvOf = (p: Vec3): Uv => {
    const [s, t] = planar(p);
    return [(s - bounds.s0) / spanS, (t - bounds.t0) / spanT];
  };
  const stretch = harmonic === null ? null : parameterStretch(mesh, faces, harmonic.uv);
  const swapped = stretch === null ? spanT > spanS : stretch.v > stretch.u;
  const orientUv = ([u, v]: Uv): Uv => (swapped ? [v, 1 - u] : [u, v]);
  const orient = (p: Vec3): Uv => orientUv(uvOf(p));
  const [longSpan, shortSpan] =
    stretch !== null ? [Math.max(stretch.u, stretch.v), Math.min(stretch.u, stretch.v)] : swapped ? [spanT, spanS] : [spanS, spanT];
  const fitUv = harmonic !== null ? picked.map((v) => orientUv(hv(v))) : points.map(orient);
  return { orient, orientUv, swapped, longSpan, shortSpan, fitUv };
}

/** The pole grids tried, in order: the given one, the growing list of a maxDeviation drive, or one chosen from the mesh density. */
function gridSizes(options: FitOptions, degree: number, sampleCount: number, parameters: UvParameters): Grid[] {
  const { longSpan, shortSpan } = parameters;
  return options.controlPoints !== undefined
    ? [options.controlPoints]
    : (options.maxDeviation !== undefined
        ? AUTO_LONG_SIDES
        : [Math.min(16, Math.max(degree + 1, Math.round(Math.sqrt(sampleCount) / 3)))]
      ).map(
        (long): Grid => [
          Math.max(degree + 1, long),
          Math.min(Math.max(degree + 1, Math.round((long * shortSpan) / longSpan)), MAX_CONTROL_POINTS),
        ],
      );
}

interface FittedGrid {
  fit: PatchFit;
  size: Grid;
}

/** Fits the grids in order until the deviation is met, the poles exceed the cap or the samples cannot determine the grid; or the refusal. */
function fitGrids(
  sizes: readonly Grid[],
  points: readonly Vec3[],
  weights: readonly number[],
  fitUv: readonly Uv[],
  degree: number,
  smoothing: number,
  maxDeviation: number | undefined,
  fail: Fail,
): { readonly fitted: FittedGrid[] } | CommandResult {
  const fitted: FittedGrid[] = [];
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
      tolerance: maxDeviation,
    });
    if (fit === null) return fail('MESH_FIT_FAILED', 'the least-squares solve produced non-finite poles');
    fitted.push({ fit, size });
    if (maxDeviation !== undefined && fit.stats.max <= maxDeviation) break;
  }
  return { fitted };
}

function parameterizationData(harmonic: HarmonicMap | null): Record<string, unknown> {
  return harmonic === null
    ? { method: 'projection' }
    : {
        method: 'harmonic',
        weights: harmonic.weights,
        flippedWithExactWeights: harmonic.flippedFirst,
        collapsedTriangles: harmonic.collapsedInParameters,
        interiorVertices: harmonic.interiorVertices,
        boundaryVertices: harmonic.boundaryVertices,
        corners: harmonic.corners,
        cgIterations: harmonic.cgIterations,
        cgResidual: harmonic.cgResidual,
      };
}

function fitWarnings(
  converged: boolean,
  largest: number,
  maxDeviation: number | undefined,
  size: Grid,
  unit: string,
  harmonic: HarmonicMap | null,
): Array<{ code: string; message: string }> {
  return [
    ...(converged
      ? []
      : [
          {
            code: 'MESH_FIT_NOT_CONVERGED',
            message: `largest distance ${largest.toPrecision(4)} ${unit} > ${maxDeviation} with the largest grid tried (${size[0]} x ${size[1]}); the surface was still created`,
          },
        ]),
    ...(harmonic !== null && harmonic.collapsedInParameters > 0
      ? [
          {
            code: 'MESH_FIT_PARAM_COLLAPSED',
            message: `${harmonic.collapsedInParameters} triangle(s) of the region have no area in the parameter square (all three vertices on one side of it: a zigzag boundary or a sliver at the boundary); the patch edge cannot follow them and the deviation is largest there; pick a region with a smoother boundary (faceGroups, a cleaner cut)`,
          },
        ]
      : []),
  ];
}

interface FitRun {
  readonly id: string;
  readonly degree: number;
  readonly smoothing: number;
  readonly options: FitOptions;
  readonly loaded: SolidMesh;
  readonly selection: RegionSelection;
  readonly parameterization: Parameterization;
  readonly samples: RegionSamples;
  readonly used: readonly number[];
  readonly points: readonly Vec3[];
  readonly parameters: UvParameters;
  readonly fitted: readonly FittedGrid[];
}

/** Measures the last patch against the region, commits the surface and reports the fit in `data`. */
function commitFit(doc: CadDocument, run: FitRun): CommandResult {
  const { id, degree, smoothing, options, loaded, selection, parameterization, samples, used, points, parameters, fitted } = run;
  const { framed, harmonic } = parameterization;
  const { measured, measuredUv } = samples;
  const { orient, orientUv, swapped } = parameters;
  const vertex = vertexReader(loaded.mesh);
  const hv = harmonicUv(harmonic);
  const last = fitted[fitted.length - 1] as FittedGrid;
  const stride2 = Math.max(1, Math.ceil((used.length + measured.length) / MAX_MEASURED));
  const everything = [...used.map(vertex), ...measured].filter((_, i) => i % stride2 === 0);
  const everythingUv =
    harmonic !== null
      ? [...used.map((v) => orientUv(hv(v))), ...measuredUv.map(orientUv)].filter((_, i) => i % stride2 === 0)
      : everything.map(orient);
  const check = footPoints(last.fit.surface, everything, everythingUv);
  const converged = options.maxDeviation === undefined || check.stats.max <= options.maxDeviation;
  const unit = doc.units;
  const rounded = {
    ...last.fit.surface,
    poles: last.fit.surface.poles.map((row) => row.map((p): Vec3 => [round6(p[0]), round6(p[1]), round6(p[2])])),
  };
  const defaults = [
    ...(options.degree === undefined ? [namedDefault('degree', DEFAULT_DEGREE, '1', 'FR-MSH-24 default')] : []),
    ...(options.smoothing === undefined ? [namedDefault('smoothing', DEFAULT_SMOOTHING, '1', 'TECHNICAL_SPEC 5.9')] : []),
  ];
  const committed = commitSurface(
    doc,
    rounded,
    { color: options.color, layerId: options.layerId, name: options.name },
    (surfaceId) =>
      `fit_surface_to_mesh '${id}' -> '${surfaceId}': degree ${degree}, ${last.size[0]} x ${last.size[1]} poles from ${points.length} of ${used.length} region vertices, ` +
      `max deviation ${check.stats.max.toPrecision(3)} ${unit} (rms ${check.stats.rms.toPrecision(3)}) in ${last.fit.rounds} round(s)${converged ? '' : `, NOT within ${options.maxDeviation} ${unit}`}.`,
  );
  const surfaceId = committed.affected[0] as string;
  const { frame } = framed;
  return {
    ...committed,
    data: withConventions(
      doc,
      {
        id: surfaceId,
        sourceId: id,
        degree,
        controlPoints: last.size,
        regionTriangles: selection.faces.length,
        ...(selection.groups === null ? {} : { faceGroups: { ...selection.groups, triangles: selection.groupFaces?.size ?? 0 } }),
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
        requestedMaxDeviation: options.maxDeviation ?? null,
        converged,
        foldedFraction: framed.foldedFraction,
        smoothing,
        parameterization: parameterizationData(harmonic),
        frame:
          harmonic === null
            ? { origin: frame.origin, uAxis: frame.uAxis, vAxis: frame.vAxis, normal: frame.normal, longAxis: swapped ? 'v' : 'u' }
            : null,
        warnings: fitWarnings(converged, check.stats.max, options.maxDeviation, last.size, unit, harmonic),
      },
      { unverified: loaded.unverified, defaults },
    ),
  };
}

const failer =
  (doc: CadDocument, id: string): Fail =>
  (code, message, path) =>
    meshRejection(doc, 'fit_surface_to_mesh', code, message, [id], path !== undefined ? [`params.${path}`] : []);

/** The refusal of a pole grid with fewer than degree + 1 poles in a direction, or null. */
export function controlPointsRefusal(doc: CadDocument, params: FitOptions & { readonly id: string }): CommandResult | null {
  const degree = params.degree ?? DEFAULT_DEGREE;
  if (params.controlPoints === undefined || !params.controlPoints.some((count) => count < degree + 1)) return null;
  return failer(doc, params.id)(
    'MESH_PARAM_INVALID',
    `controlPoints needs at least degree + 1 = ${degree + 1} poles per direction`,
    'controlPoints',
  );
}

export function runFit(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  loaded: SolidMesh,
  params: FitOptions & {
    readonly id: string;
    readonly region?: FitRegion | undefined;
    readonly faceGroups?: z.infer<typeof faceGroupsParam> | undefined;
    readonly parameterization?: (typeof PARAMETERIZATIONS)[number] | undefined;
  },
): CommandResult {
  const { id, region } = params;
  const degree = params.degree ?? DEFAULT_DEGREE;
  const smoothing = params.smoothing ?? DEFAULT_SMOOTHING;
  const fail = failer(doc, id);
  const { mesh } = loaded;
  const selection = selectRegion(doc, ctx, id, loaded, params.faceGroups, region, fail);
  if ('document' in selection) return selection;
  const { faces } = selection;
  const parameterization = parameterize(doc, ctx, id, mesh, faces, params.parameterization ?? 'auto', fail);
  if ('document' in parameterization) return parameterization;
  const samples = sampleRegion(mesh, faces, parameterization.harmonic);
  const vertex = vertexReader(mesh);
  const { vertexWeight } = samples;
  const used = [...vertexWeight.keys()].sort((x, y) => x - y);
  const stride = Math.max(1, Math.ceil(used.length / MAX_FIT_VERTICES));
  const picked = used.filter((_, i) => i % stride === 0);
  const points = picked.map(vertex);
  const total = picked.reduce((sum, v) => sum + (vertexWeight.get(v) as number), 0);
  const weights = picked.map((v) => (vertexWeight.get(v) as number) / total);
  const parameters = parameterFrame(mesh, faces, parameterization, used, picked, points);
  if (parameters === null) return fail('MESH_FIT_REGION_EMPTY', 'the region is degenerate in its best-fit plane', 'region');
  const sizes = gridSizes(params, degree, points.length, parameters);
  const fit = fitGrids(sizes, points, weights, parameters.fitUv, degree, smoothing, params.maxDeviation, fail);
  if ('document' in fit) return fit;
  return commitFit(doc, {
    id,
    degree,
    smoothing,
    options: params,
    loaded,
    selection,
    parameterization,
    samples,
    used,
    points,
    parameters,
    fitted: fit.fitted,
  });
}
