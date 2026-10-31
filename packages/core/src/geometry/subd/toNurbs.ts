/**
 * Subdivision cage -> NURBS sheets (04 DIR §5.8). The cage is refined once (until its semi-sharp creases have decayed, so every face is a
 * quad); each refined quad becomes a bicubic Bézier patch (`quadCagePatches`): around regular vertices the patch IS the Catmull-Clark limit
 * surface (uniform bicubic B-spline in Bézier form); next to extraordinary vertices (EV) and creases it is the Loop-Schaefer geometry patch
 * (shared boundary poles, so the sheet is G0 across every seam, and every patch of a star shares the tangent plane at the EV itself). The
 * tangent break along the edges next to an EV shrinks by about 0.43 per extra refinement level, so `tangentToleranceDeg` refines until the
 * measured break is below it. `packed` merges maximal blocks of regular quads into one B-spline surface each. The report measures the
 * deviation from the limit surface and the continuity along EV edges.
 */

import type { Vec3 } from '../../model/types';
import { distance3, dot3 } from '../../lib/vec3';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { type Cage, subdivide } from '../subdivision';
import { type BezierPatch, patchPoint, quadCagePatches } from '../subdivisionPatches';
import { edgeKey } from './edgeKey';
import { type ExactG1, type ExactG1Group, solveExactG1 } from './g1Exact';
import { DENSE_MAX_UNKNOWNS } from './g1Linear';
import { MEASURE_STATIONS, fitTangentPlanes, patchNormal } from './g1Fit';
import { prepare, surfaceEvaluator } from './limit';
import { blockSurface, packedBlocks } from './packedGrids';
import { settleLevels } from './settle';
import { buildTopology } from './topology';

export interface ToNurbsOptions {
  readonly packed: boolean;
  /** Refine until the largest normal angle along an extraordinary-vertex edge is below this (degrees); absent = the base level only. */
  readonly tangentToleranceDeg?: number | undefined;
  /** Deviation samples per patch side (a samples x samples grid of cell centres). */
  readonly samples: number;
  /** Fit the interior poles of the quads around extraordinary vertices to the tangent planes of their neighbours (`g1Fit.ts`). */
  readonly fitTangents?: boolean | undefined;
  /**
   * With `fitTangents`: "exact" = the linear G1 solve (`g1Exact.ts`), the fit where it has no solution; "fit" = the approximate tangent-plane fit only; "auto" (default) = both are
   * built and the exact one is kept when its break is within the tolerance and its deviation from the limit surface is at most max(1.25 x the fit one, `deviationTolerance`),
   * the fit otherwise, the exact one when only it meets the tolerance.
   * Cost: a group above `DENSE_MAX_UNKNOWNS` unknown poles is solved by conjugate gradients, and its limit-surface objective (a projected CG, up to 1.5e9 work units) runs only when the nearest-to-start
   * exact solve is not already within max(1.25 x the fit, `deviationTolerance`) of the limit surface (then `exactObjective` reads "start"); "exact" always spends it.
   */
  readonly g1Solve?: 'exact' | 'fit' | 'auto' | undefined;
  /** "auto": the deviation (document units) up to which the exact solve is accepted whatever the fit does; default 1e-3 x the diagonal of the cage. */
  readonly deviationTolerance?: number | undefined;
}

/** How the G1 method was chosen: the one kept, why, and both deviations (null where a method was not built or not valid). */
interface G1Choice {
  readonly chosen: 'exact' | 'fit';
  readonly reason: string;
  readonly exactDeviation: number | null;
  readonly fitDeviation: number | null;
}

interface EvEdgeReport {
  /** Patch indices on both sides of the edge (indices of the once-refined quads). */
  readonly patches: readonly [number, number];
  readonly valence: number;
  /** Largest gap between the two patches along the edge (document units). */
  readonly g0: number;
  /** Largest angle between the two surface normals along the edge (degrees). */
  readonly g1Deg: number;
}

export interface ToNurbsResult {
  readonly surfaces: NurbsSurfaceData[];
  /** Bézier patches (refined quads) the sheets are made of. */
  readonly patchCount: number;
  /** Quads merged into packed blocks, and the number of blocks bigger than one quad. */
  readonly packedQuads: number;
  readonly packedBlocks: number;
  readonly maxDeviation: number;
  readonly deviationSamples: number;
  /** Samples next to an extraordinary vertex or crease that the evaluator only approximates: not compared. */
  readonly skippedSamples: number;
  readonly evEdges: EvEdgeReport[];
  readonly maxEvG0: number;
  readonly maxEvG1Deg: number;
  readonly refineLevels: number;
  /** With a tangent tolerance: whether the refinement reached it before the patch budget ran out; null without one. */
  readonly g1ToleranceMet: boolean | null;
  /** With a G1 request and extraordinary vertices: how the interior poles were found, "exact" (every group satisfies the linear G1 conditions) or "fit" (the tangent-plane fit); null otherwise. */
  readonly g1Method: 'exact' | 'fit' | null;
  /** The groups of quads the exact solve could not make G1 (empty when the method is "exact"). */
  readonly exactRefused: ExactG1Group[];
  /** With the exact method: "boundary-kept" (only interior poles moved) or "edges-freed" (the inner edge poles between free quads moved too); null otherwise. */
  readonly exactMethod: ExactG1['method'];
  /** Quads whose poles the exact solve was allowed to move (the patch count never changes); 0 without it. */
  readonly exactFreeQuads: number;
  /** What the exact solve's free poles approached: "limit" (the limit surface at samples), "start" (the geometry poles, groups too big for the dense path); null without the exact method. */
  readonly exactObjective: 'limit' | 'start' | null;
  readonly g1Choice: G1Choice | null;
  /** Largest deviation of the plain (G0) patches from the limit surface: what a G1 method is measured against; null without a G1 request or extraordinary vertices. */
  readonly plainMaxDeviation: number | null;
}

/** A bicubic Bézier patch as a clamped bicubic NURBS surface with domain [0, 1]². */
export function patchSurface(patch: BezierPatch): NurbsSurfaceData {
  return {
    degreeU: 3,
    degreeV: 3,
    poles: Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => patch[i * 4 + j] as Vec3)),
    knotsU: [0, 1],
    multiplicitiesU: [4, 4],
    knotsV: [0, 1],
    multiplicitiesV: [4, 4],
  };
}

/** Surface point and unit normal of `patch` at (u, v): the normal by analytic derivatives, so a break of 1e-8 rad is not drowned by differencing noise. */
function patchFrame(patch: BezierPatch, u: number, v: number): { point: Vec3; normal: Vec3 } {
  return { point: patchPoint(patch, u, v), normal: patchNormal(patch, u, v) };
}

/** Parameter of side `k` (directed v_k -> v_k+1) of a patch at fraction t along it. */
const sideParameter = (k: number, t: number): readonly [number, number] =>
  k === 0 ? [t, 0] : k === 1 ? [1, t] : k === 2 ? [1 - t, 1] : [0, 1 - t];

/** Gap (at 5 stations, ends included) and normal angle (at `MEASURE_STATIONS`) along every smooth edge that touches an extraordinary vertex; a crease edge is intentionally not G1 and is not listed (the smooth edges at a crease vertex are). */
function evEdgeReports(refined: Cage, patches: readonly BezierPatch[], valence: ReadonlyArray<number>): EvEdgeReport[] {
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const reports: EvEdgeReport[] = [];
  const creases = new Set(refined.creases.map(([a, b]) => edgeKey(a, b)));
  for (const edge of topology.edges) {
    if (edge.faces.length !== 2 || (valence[edge.a] === 4 && valence[edge.b] === 4) || creases.has(edgeKey(edge.a, edge.b))) continue;
    const [f, g] = edge.faces as [number, number];
    const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
    const kf = (refined.faces[f] as ReadonlyArray<number>).indexOf(from);
    const kg = (refined.faces[g] as ReadonlyArray<number>).indexOf(to);
    let [g0, g1] = [0, 0];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const [u1, v1] = sideParameter(kf, t);
      const [u2, v2] = sideParameter(kg, 1 - t);
      const [first, second] = [patchFrame(patches[f] as BezierPatch, u1, v1), patchFrame(patches[g] as BezierPatch, u2, v2)];
      g0 = Math.max(g0, distance3(first.point, second.point));
    }
    for (const t of MEASURE_STATIONS) {
      const [u1, v1] = sideParameter(kf, t);
      const [u2, v2] = sideParameter(kg, 1 - t);
      const [first, second] = [patchFrame(patches[f] as BezierPatch, u1, v1), patchFrame(patches[g] as BezierPatch, u2, v2)];
      const cosine = Math.min(1, Math.max(-1, dot3(first.normal, second.normal)));
      g1 = Math.max(g1, (Math.acos(cosine) * 180) / Math.PI);
    }
    reports.push({ patches: [f, g], valence: Math.max(valence[edge.a] as number, valence[edge.b] as number), g0, g1Deg: g1 });
  }
  return reports;
}

/** Largest distance between the patches and the Catmull-Clark limit surface over a grid of cell-centre samples (regular samples only). */
function deviation(refined: Cage, patches: readonly BezierPatch[], samples: number): { max: number; count: number; skipped: number } {
  const evaluate = surfaceEvaluator(refined);
  let [max, count, skipped] = [0, 0, 0];
  patches.forEach((patch, f) => {
    for (let i = 0; i < samples; i++)
      for (let j = 0; j < samples; j++) {
        const [u, v] = [(i + 0.5) / samples, (j + 0.5) / samples];
        const exact = evaluate(f, u, v);
        if (exact === null || exact.approximate) {
          skipped++;
          continue;
        }
        count++;
        max = Math.max(max, distance3(exact.point, patchPoint(patch, u, v)));
      }
  });
  return { max, count, skipped };
}

/** Largest number of patches a tangent-tolerance refinement may produce. */
const MAX_REFINED_PATCHES = 4096;

interface Build {
  readonly refined: Cage;
  readonly valence: number[];
  readonly patches: BezierPatch[];
  readonly evEdges: EvEdgeReport[];
  readonly g1Method: 'exact' | 'fit' | null;
  readonly exactRefused: ExactG1Group[];
  readonly exactMethod: ExactG1['method'];
  readonly exactFreeQuads: number;
  readonly exactObjective: 'limit' | 'start' | null;
  readonly g1Choice: G1Choice | null;
  readonly plainMaxDeviation: number | null;
  /** The exact solve was built and refused (a later refinement level does not try again). */
  readonly exactRefusedHere: boolean;
}

/** The kept method of "auto": the exact one when it meets the tolerance and stays near the limit surface, the fit when it does not, the exact one when only it meets the tolerance. */
function chooseSolve(
  exact: { breakDeg: number; deviation: number },
  fit: { breakDeg: number; deviation: number },
  tolerance: number,
  deviationTolerance: number,
): G1Choice {
  const exactDeviation = exact.deviation;
  const fitDeviation = fit.deviation;
  if (exact.breakDeg > tolerance)
    return { chosen: 'fit', reason: 'the exact solve misses the tangent tolerance', exactDeviation, fitDeviation };
  if (fit.breakDeg > tolerance)
    return { chosen: 'exact', reason: 'only the exact solve meets the tangent tolerance', exactDeviation, fitDeviation };
  if (exactDeviation <= Math.max(1.25 * fitDeviation, deviationTolerance))
    return {
      chosen: 'exact',
      reason: 'both meet the tolerance and the exact deviation is within max(1.25 x the fit, the deviation tolerance)',
      exactDeviation,
      fitDeviation,
    };
  return {
    chosen: 'fit',
    reason: 'both meet the tolerance and the exact deviation exceeds max(1.25 x the fit, the deviation tolerance)',
    exactDeviation,
    fitDeviation,
  };
}

function buildLevel(cage: Cage, levels: number, options: ToNurbsOptions, allowExact: boolean): Build {
  const refined = subdivide(cage, levels);
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const valence = topology.vertexEdges.map((edges, v) =>
    edges.length === (topology.vertexFaces[v] as number[]).length ? edges.length : 4,
  );
  const geometry = quadCagePatches(refined);
  const fit = options.fitTangents === true;
  const hasStar = valence.some((n) => n !== 4);
  const mode = options.g1Solve ?? 'auto';
  const build = (patches: BezierPatch[]): Build => ({
    refined,
    valence,
    patches,
    evEdges: evEdgeReports(refined, patches, valence),
    g1Method: null,
    exactRefused: [],
    exactMethod: null,
    exactFreeQuads: 0,
    exactObjective: null,
    g1Choice: null,
    plainMaxDeviation: null,
    exactRefusedHere: false,
  });
  if (!fit || !hasStar) return build(geometry);
  // the exact linear solve (a cage whose groups it cannot make G1 keeps the approximate fit), the approximate fit, the plain patches to measure both against
  // "auto" first builds the cheap exact solve (groups too big for the dense path keep the nearest-to-start poles) and spends the limit-surface objective on them only when it is needed
  const solveExact = (sparseObjective: 'limit' | 'start'): ExactG1 | null =>
    mode !== 'fit' && allowExact ? solveExactG1(refined, geometry, valence, { sparseObjective }) : null;
  let exact = solveExact(mode === 'auto' ? 'start' : 'limit');
  const exactHolds = exact !== null && exact.groups.length > 0 && exact.groups.every((group) => group.consistent);
  const fitted = mode === 'exact' && exactHolds ? null : fitTangentPlanes(refined, geometry, valence);
  const plainMaxDeviation = deviation(refined, geometry, options.samples).max;
  let chosen: 'exact' | 'fit' = exactHolds ? 'exact' : 'fit';
  let g1Choice: G1Choice | null = null;
  if (mode === 'auto' && exactHolds && fitted !== null && exact !== null) {
    const diagonal = Math.hypot(
      ...[0, 1, 2].map(
        (axis) => Math.max(...refined.vertices.map((p) => p[axis] as number)) - Math.min(...refined.vertices.map((p) => p[axis] as number)),
      ),
    );
    const measure = (patches: BezierPatch[]): { breakDeg: number; deviation: number } => ({
      breakDeg: Math.max(0, ...evEdgeReports(refined, patches, valence).map((edge) => edge.g1Deg)),
      deviation: deviation(refined, patches, options.samples).max,
    });
    const [angleTolerance, deviationTolerance] = [options.tangentToleranceDeg ?? Infinity, options.deviationTolerance ?? 1e-3 * diagonal];
    const fitMeasure = measure(fitted);
    let exactMeasure = measure(exact.patches);
    g1Choice = chooseSolve(exactMeasure, fitMeasure, angleTolerance, deviationTolerance);
    // the limit objective of the big groups (the conjugate-gradient path: up to 1.5e9 work units) is only worth its cost when the nearest-to-start poles are not already within max(1.25 x the fit, the deviation tolerance)
    const spared = g1Choice.chosen === 'exact' && exactMeasure.deviation <= Math.max(1.25 * fitMeasure.deviation, deviationTolerance);
    if (!spared && exact.groups.some((group) => group.unknowns > DENSE_MAX_UNKNOWNS)) {
      exact = solveExact('limit') ?? exact;
      exactMeasure = measure(exact.patches);
      g1Choice = chooseSolve(exactMeasure, fitMeasure, angleTolerance, deviationTolerance);
    }
    chosen = g1Choice.chosen;
  } else if (mode === 'auto' && !exactHolds)
    g1Choice = {
      chosen: 'fit',
      reason: exact === null ? 'the exact solve was refused at a coarser level' : 'the exact solve has no solution for this cage',
      exactDeviation: null,
      fitDeviation: null,
    };
  else if (mode !== 'auto')
    g1Choice = {
      chosen,
      reason: `g1Solve "${mode}" was asked for${mode === 'exact' && !exactHolds ? ' (the exact solve has no solution: the fit)' : ''}`,
      exactDeviation: null,
      fitDeviation: null,
    };
  const patches = chosen === 'exact' && exact !== null ? exact.patches : (fitted ?? fitTangentPlanes(refined, geometry, valence));
  return {
    ...build(patches),
    g1Method: chosen,
    exactRefused: exact === null ? [] : exact.groups.filter((group) => !group.consistent),
    exactMethod: chosen === 'exact' && exact !== null ? exact.method : null,
    exactFreeQuads: chosen === 'exact' && exact !== null ? exact.freeQuads : 0,
    exactObjective:
      chosen === 'exact' && exact !== null ? (exact.groups.every((group) => group.objective === 'limit') ? 'limit' : 'start') : null,
    g1Choice,
    plainMaxDeviation,
    exactRefusedHere: exact !== null && !exactHolds,
  };
}

const worstBreak = (build: Build): number => Math.max(0, ...build.evEdges.map((edge) => edge.g1Deg));

/** The cage's patches as NURBS sheets with the conversion report. The cage may be open (boundary edges are creases) and may contain n-gons. */
export function cageToNurbs(cage: Cage, options: ToNurbsOptions): ToNurbsResult {
  let refineLevels = Math.max(1, settleLevels(cage));
  let build = buildLevel(cage, refineLevels, options, true);
  let allowExact = !build.exactRefusedHere;
  let refusal = build.exactRefused;
  const tolerance = options.tangentToleranceDeg;
  while (tolerance !== undefined && worstBreak(build) > tolerance && build.patches.length * 4 <= MAX_REFINED_PATCHES) {
    refineLevels++;
    // an exact solve that was refused is not tried again on the finer cages (its cost grows with them and the refusal does not go away)
    build = buildLevel(cage, refineLevels, options, allowExact);
    if (build.exactRefusedHere) refusal = build.exactRefused;
    allowExact = allowExact && !build.exactRefusedHere;
  }
  const { refined, patches, evEdges } = build;
  const blocks = options.packed ? packedBlocks(prepare(refined)).filter((block) => block.quads.length > 1) : [];
  const covered = new Set(blocks.flatMap((block) => block.quads));
  const surfaces = [
    ...blocks.map((block) => blockSurface(block, refined.vertices)),
    ...patches.flatMap((patch, f) => (covered.has(f) ? [] : [patchSurface(patch)])),
  ];
  const measured = deviation(refined, patches, options.samples);
  return {
    surfaces,
    patchCount: patches.length,
    packedQuads: covered.size,
    packedBlocks: blocks.length,
    maxDeviation: measured.max,
    deviationSamples: measured.count,
    skippedSamples: measured.skipped,
    evEdges,
    maxEvG0: Math.max(0, ...evEdges.map((edge) => edge.g0)),
    maxEvG1Deg: worstBreak(build),
    refineLevels,
    g1ToleranceMet: tolerance === undefined ? null : worstBreak(build) <= tolerance,
    g1Method: build.g1Method,
    // the groups refused at the level where the exact solve was tried (the finer levels do not try again)
    exactRefused: build.exactMethod === null ? refusal : [],
    exactMethod: build.exactMethod,
    exactFreeQuads: build.exactFreeQuads,
    exactObjective: build.exactObjective,
    g1Choice: build.g1Choice,
    plainMaxDeviation: build.plainMaxDeviation,
  };
}
