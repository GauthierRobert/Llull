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
import { cross3, distance3, dot3, normalize3OrZero, sub3 } from '../../lib/vec3';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { type Cage, subdivide } from '../subdivision';
import { type BezierPatch, patchPoint, quadCagePatches } from '../subdivisionPatches';
import { fitTangentPlanes } from './g1Fit';
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

/** Surface point and unit normal of `patch` at (u, v). */
function patchFrame(patch: BezierPatch, u: number, v: number): { point: Vec3; normal: Vec3 } {
  const h = 1e-6;
  const [u0, u1] = [Math.max(0, u - h), Math.min(1, u + h)];
  const [v0, v1] = [Math.max(0, v - h), Math.min(1, v + h)];
  const du = sub3(patchPoint(patch, u1, v), patchPoint(patch, u0, v));
  const dv = sub3(patchPoint(patch, u, v1), patchPoint(patch, u, v0));
  return { point: patchPoint(patch, u, v), normal: normalize3OrZero(cross3(du, dv)) };
}

/** Parameter of side `k` (directed v_k -> v_k+1) of a patch at fraction t along it. */
const sideParameter = (k: number, t: number): readonly [number, number] =>
  k === 0 ? [t, 0] : k === 1 ? [1, t] : k === 2 ? [1 - t, 1] : [0, 1 - t];

/** Gap and normal angle along every edge that touches an extraordinary vertex. */
function evEdgeReports(refined: Cage, patches: readonly BezierPatch[], valence: ReadonlyArray<number>): EvEdgeReport[] {
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const reports: EvEdgeReport[] = [];
  for (const edge of topology.edges) {
    if (edge.faces.length !== 2 || (valence[edge.a] === 4 && valence[edge.b] === 4)) continue;
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
}

function buildLevel(cage: Cage, levels: number, fit: boolean): Build {
  const refined = subdivide(cage, levels);
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const valence = topology.vertexEdges.map((edges, v) =>
    edges.length === (topology.vertexFaces[v] as number[]).length ? edges.length : 4,
  );
  const geometry = quadCagePatches(refined);
  const patches = fit ? fitTangentPlanes(refined, geometry, valence) : geometry;
  return { refined, valence, patches, evEdges: evEdgeReports(refined, patches, valence) };
}

const worstBreak = (build: Build): number => Math.max(0, ...build.evEdges.map((edge) => edge.g1Deg));

/** The cage's patches as NURBS sheets with the conversion report. The cage may be open (boundary edges are creases) and may contain n-gons. */
export function cageToNurbs(cage: Cage, options: ToNurbsOptions): ToNurbsResult {
  let refineLevels = Math.max(1, settleLevels(cage));
  const fit = options.fitTangents === true;
  let build = buildLevel(cage, refineLevels, fit);
  const tolerance = options.tangentToleranceDeg;
  while (tolerance !== undefined && worstBreak(build) > tolerance && build.patches.length * 4 <= MAX_REFINED_PATCHES) {
    refineLevels++;
    build = buildLevel(cage, refineLevels, fit);
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
  };
}
