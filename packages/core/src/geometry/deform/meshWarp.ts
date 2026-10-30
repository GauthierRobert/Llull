/**
 * Mesh path of a space deformation (01 DEF §5.7): the source triangles are split until every edge is short enough for the law's curvature
 * bound (and cut at the region ends where the map has a kink), then every vertex is moved by the exact map.
 * @invariant deterministic: same mesh + node -> same triangles; winding follows the map (an orientation-reversing affine map flips it)
 * @invariant watertight in, watertight out: edges are split through a shared edge table, so neighbouring triangles agree on every new vertex
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { type DeformNode, warpOf } from './laws';
import { localExtentOf, maxEdgeLength, splitHeights } from './bounds';
import { toLocal } from './frame';
import { edgeActive, featureEdgeLength } from './influence';
import { meshDiagonal, weldMesh } from '../mesh/weld';

/** Triangles above which the mesh path refuses (01 DEF §5.7). */
export const MAX_WARP_TRIANGLES = 4_000_000;

/** Refinement passes before giving up (each pass at least halves the longest edge). */
const MAX_PASSES = 40;

/**
 * The chord deviation of an edge of length h of a Lipschitz map is at most about (1 + Lip) h and, for a smooth one, of the order h² (a kink: h): deviation / h falls or stays
 * bounded as the edges shrink. At a discontinuity or a fold the deviation stays the size of the jump, so deviation / h doubles with every pass and the triangle count grows without
 * bound. After MIN_PASSES the worst deviation / h of the edges a pass splits must not exceed GROWTH times its value PROGRESS_WINDOW passes earlier (while the deviation is above
 * ten tolerances and above SLOPE_LIMIT), else the refinement is refused.
 */
const PROGRESS_WINDOW = 3;
const MIN_PASSES_BEFORE_PROGRESS_CHECK = 5;
const GROWTH = 4;
/** A deviation / edge length above this (an image edge a hundred times longer than its edge) is a jump or a fold, not a body deformation (det J of 1e6). */
const SLOPE_LIMIT = 100;

/** Chord evaluations (one map evaluation each) before the mesh path gives up, whatever the triangle count: 4e7 for a cheap map, less for one that solves for its argument. */
const MAX_EVALUATIONS = 4e7;

/** Cost of one evaluation of a law relative to a closed-form one (the base-frame laws run a Newton solve per point). */
function evaluationCost(node: DeformNode): number {
  const { law } = node;
  return (law.kind === 'flowCurve' && law.base !== undefined) || (law.kind === 'flowSurface' && law.baseNodes !== undefined) ? 20 : 1;
}

export interface WarpResult {
  readonly ok: true;
  readonly mesh: MeshData;
  /** Triangles of the welded source before refinement. */
  readonly sourceTriangles: number;
  /** Longest edge allowed by the refinement bound (Infinity: none needed). */
  readonly edgeLength: number;
  /** Largest chordal deviation over the refined edges: |F(mid) − mid(F(a), F(b))|. */
  readonly maxChordError: number;
}

export interface WarpFailure {
  readonly ok: false;
  readonly code: 'DEF_BUDGET_EXCEEDED' | 'DEF_FRAME_DEGENERATE' | 'DEF_APPROX_TOLERANCE';
  readonly message: string;
}

export interface WarpOptions {
  /** Maximum chordal deviation (document units, > 0). */
  readonly tolerance: number;
  readonly maxTriangles?: number;
}

export interface Soup {
  positions: number[];
  indices: number[];
}

/** Split decision for the edge from vertex `low` to vertex `high` (`low` < `high`): the parameter in (0, 1) of the new vertex, or null. */
type EdgeSplit = (low: number, high: number) => number | null;

const at = (positions: ReadonlyArray<number>, vertex: number): Vec3 => [
  positions[vertex * 3] as number,
  positions[vertex * 3 + 1] as number,
  positions[vertex * 3 + 2] as number,
];

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** One splitting pass: every edge `decide` accepts gets a vertex; triangles are re-cut (1, 2 or 3 split edges). Returns whether anything split. */
export function splitPass(soup: Soup, decide: EdgeSplit): boolean {
  const { positions, indices } = soup;
  const vertexCount = positions.length / 3;
  const created = new Map<number, number>();
  const nextIndices: number[] = [];
  const split = (a: number, b: number): number => {
    const [low, high] = a < b ? [a, b] : [b, a];
    const key = low * vertexCount + high;
    const known = created.get(key);
    if (known !== undefined) return known;
    const t = decide(low, high);
    if (t === null) {
      created.set(key, -1);
      return -1;
    }
    const index = positions.length / 3;
    const [p, q] = [at(positions, low), at(positions, high)];
    positions.push(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t);
    created.set(key, index);
    return index;
  };
  let any = false;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const v = [indices[t] as number, indices[t + 1] as number, indices[t + 2] as number];
    const m = [split(v[0] as number, v[1] as number), split(v[1] as number, v[2] as number), split(v[2] as number, v[0] as number)];
    const splits = m.filter((index) => index >= 0).length;
    if (splits === 0) {
      nextIndices.push(...v);
      continue;
    }
    any = true;
    if (splits === 3) {
      const [a, b, c, ab, bc, ca] = [v[0], v[1], v[2], m[0], m[1], m[2]] as number[];
      nextIndices.push(a as number, ab as number, ca as number, ab as number, b as number, bc as number);
      nextIndices.push(ca as number, bc as number, c as number, ab as number, bc as number, ca as number);
      continue;
    }
    // rotate so the first split edge is edge 0 (and, for two splits, the unsplit edge is edge 2)
    let r = m.findIndex((index) => index >= 0);
    if (splits === 2 && (m[(r + 2) % 3] as number) >= 0) r = (r + 2) % 3;
    const [a, b, c] = [v[r], v[(r + 1) % 3], v[(r + 2) % 3]] as number[];
    const first = m[r] as number;
    if (splits === 1) {
      nextIndices.push(a as number, first, c as number, first, b as number, c as number);
    } else {
      const second = m[(r + 1) % 3] as number;
      nextIndices.push(first, b as number, second);
      const [pa, pc, pf, ps] = [at(positions, a as number), at(positions, c as number), at(positions, first), at(positions, second)];
      if (distance(pf, pc) <= distance(pa, ps)) nextIndices.push(a as number, first, c as number, first, second, c as number);
      else nextIndices.push(a as number, first, second, a as number, second, c as number);
    }
  }
  soup.indices = nextIndices;
  return any;
}

/** Sample parameters along an edge at which the chordal deviation is measured. */
const CHORD_SAMPLES = [0.25, 0.5, 0.75];

/** What the chord rule of one pass saw: the largest deviation of an edge it split, the largest deviation / edge length, and the map evaluations it made. */
interface ChordTally {
  worst: number;
  slope: number;
  evaluations: number;
}

/**
 * Split an edge (at its middle) when the deformed curve leaves its chord by more than the tolerance at a quarter, half or three quarters of the
 * edge; edges outside the zone the map acts in (the open region of an axis law, a lattice box, a push support) stay. This measures the deviation the bound maxEdgeLength only estimates.
 */
function chordRule(
  positions: ReadonlyArray<number>,
  active: (p: Vec3, q: Vec3) => boolean,
  tolerance: number,
  point: (p: Vec3) => Vec3,
  tally: ChordTally,
): EdgeSplit {
  const images = new Map<number, Vec3>();
  const image = (vertex: number): Vec3 => {
    const known = images.get(vertex);
    if (known !== undefined) return known;
    const mapped = point(at(positions, vertex));
    images.set(vertex, mapped);
    return mapped;
  };
  return (low, high) => {
    const [p, q] = [at(positions, low), at(positions, high)];
    if (!active(p, q) || distance(p, q) < tolerance / 64) return null;
    const [fp, fq] = [image(low), image(high)];
    for (const t of CHORD_SAMPLES) {
      tally.evaluations++;
      const onEdge = point([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
      const deviation = Math.hypot(
        onEdge[0] - (fp[0] + (fq[0] - fp[0]) * t),
        onEdge[1] - (fp[1] + (fq[1] - fp[1]) * t),
        onEdge[2] - (fp[2] + (fq[2] - fp[2]) * t),
      );
      if (deviation > tolerance) {
        tally.worst = Math.max(tally.worst, deviation);
        tally.slope = Math.max(tally.slope, deviation / distance(p, q));
        return 0.5;
      }
    }
    return null;
  };
}

/** Splits the edges longer than `limit` that lie within one edge length of the influence zone of a local feature (a point push, a lattice cell): the chord test alone cannot see a bump that no edge of a big triangle crosses. */
function featureRule(positions: ReadonlyArray<number>, limit: number, near: (p: Vec3, q: Vec3, margin: number) => boolean): EdgeSplit {
  return (low, high) => {
    const [p, q] = [at(positions, low), at(positions, high)];
    const length = distance(p, q);
    return length > limit && near(p, q, length) ? 0.5 : null;
  };
}

/** Local heights of every vertex (recomputed after each pass: new vertices were appended). */
function heightsOf(soup: Soup, node: DeformNode): Float64Array {
  const warp = warpOf(node);
  const count = soup.positions.length / 3;
  const heights = new Float64Array(count);
  if (warp === null) return heights;
  for (let v = 0; v < count; v++) heights[v] = toLocal(warp.frame, at(soup.positions, v))[2];
  return heights;
}

/** Cut the edges that cross the local height `z` (the vertices stay at least `gap` from the plane). */
function planeRule(heights: Float64Array, z: number, gap: number): EdgeSplit {
  return (low, high) => {
    const [za, zb] = [heights[low] as number, heights[high] as number];
    const crosses = (za < z - gap && zb > z + gap) || (zb < z - gap && za > z + gap);
    return crosses ? (z - za) / (zb - za) : null;
  };
}

/** Largest |F(mid) − mid(F(a), F(b))| over the unique edges of `soup`. */
function chordError(soup: Soup, point: (p: Vec3) => Vec3): number {
  const images = new Map<number, Vec3>();
  const image = (v: number): Vec3 => {
    const known = images.get(v);
    if (known !== undefined) return known;
    const mapped = point(at(soup.positions, v));
    images.set(v, mapped);
    return mapped;
  };
  let worst = 0;
  const { indices } = soup;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [indices[t + k] as number, indices[t + ((k + 1) % 3)] as number];
      if (a >= b) continue;
      const [p, q] = [at(soup.positions, a), at(soup.positions, b)];
      const mid = point([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]);
      const [fp, fq] = [image(a), image(b)];
      worst = Math.max(worst, Math.hypot(mid[0] - (fp[0] + fq[0]) / 2, mid[1] - (fp[1] + fq[1]) / 2, mid[2] - (fp[2] + fq[2]) / 2));
    }
  }
  return worst;
}

/** Whether the law reverses orientation everywhere (negative affine determinant). */
function reversesOrientation(node: DeformNode): boolean {
  const warp = warpOf(node);
  return warp !== null && node.law.kind === 'affine' && warp.determinant([0, 0, 0]) < 0;
}

/**
 * Deform the triangles of `source` (world space, any indexing; welded here) by `node`.
 * @failure degenerate frame -> DEF_FRAME_DEGENERATE; more than `maxTriangles` after (or estimated before) refinement -> DEF_BUDGET_EXCEEDED
 */
export function warpMesh(source: MeshData, node: DeformNode, options: WarpOptions): WarpResult | WarpFailure {
  const warp = warpOf(node);
  if (warp === null)
    return { ok: false, code: 'DEF_FRAME_DEGENERATE', message: 'the frame axis is zero or the reference is parallel to it' };
  const cap = options.maxTriangles ?? MAX_WARP_TRIANGLES;
  const welded = weldMesh(source, 1e-7 * meshDiagonal(source.positions));
  const soup: Soup = { positions: welded.positions, indices: welded.triangles };
  const sourceTriangles = soup.indices.length / 3;
  const extent = localExtentOf(warp.frame, soup.positions);
  const edgeLength = maxEdgeLength(node, extent, options.tolerance);
  const gap = 1e-9 * Math.max(extent.max[2] - extent.min[2], 1e-12);
  const overBudget = (count: number): WarpFailure => ({
    ok: false,
    code: 'DEF_BUDGET_EXCEEDED',
    message: `refining to edges of ${edgeLength.toPrecision(3)} would need about ${Math.round(count)} triangles (limit ${cap})`,
  });
  const estimate = estimateWarp(source, node, options.tolerance);
  if (estimate !== null && estimate.triangles > cap) return overBudget(estimate.triangles);
  for (const z of splitHeights(node)) {
    if (z > extent.min[2] + gap && z < extent.max[2] - gap) splitPass(soup, planeRule(heightsOf(soup, node), z, gap));
  }
  if (node.law.kind !== 'affine') {
    const active = edgeActive(node, warp.frame);
    const limit = featureEdgeLength(node);
    const slopeByPass: number[] = [];
    let evaluations = 0;
    const cost = evaluationCost(node);
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const tally: ChordTally = { worst: 0, slope: 0, evaluations: 0 };
      const chord = chordRule(soup.positions, active, options.tolerance, warp.point, tally);
      const feature = Number.isFinite(limit) ? featureRule(soup.positions, limit, active) : null;
      const decide: EdgeSplit = (low, high) => (feature === null ? null : feature(low, high)) ?? chord(low, high);
      if (!splitPass(soup, decide)) break;
      if (soup.indices.length / 3 > cap) return overBudget(soup.indices.length / 3);
      slopeByPass.push(tally.slope);
      evaluations += tally.evaluations * cost;
      if (evaluations > MAX_EVALUATIONS)
        return {
          ok: false,
          code: 'DEF_BUDGET_EXCEEDED',
          message: `refining would need more than ${MAX_EVALUATIONS} (weighted) evaluations of the map after ${pass + 1} passes (${soup.indices.length / 3} triangles)`,
        };
      const earlier = slopeByPass[pass - PROGRESS_WINDOW];
      if (
        pass >= MIN_PASSES_BEFORE_PROGRESS_CHECK &&
        earlier !== undefined &&
        tally.worst > options.tolerance * 10 &&
        tally.slope > SLOPE_LIMIT &&
        tally.slope > GROWTH * earlier
      )
        return {
          ok: false,
          code: 'DEF_APPROX_TOLERANCE',
          message: `refining the mesh does not reduce the chordal deviation of the map (still ${tally.worst.toPrecision(3)} after ${pass + 1} passes, ${soup.indices.length / 3} triangles; deviation per edge length ${tally.slope.toPrecision(3)}, growing): the map is discontinuous or folded in the body, so no tolerance can be met`,
        };
    }
  }
  const maxChordError = chordError(soup, warp.point);
  const moved: number[] = new Array<number>(soup.positions.length);
  for (let v = 0; v < soup.positions.length / 3; v++) {
    const p = warp.point(at(soup.positions, v));
    moved[v * 3] = p[0];
    moved[v * 3 + 1] = p[1];
    moved[v * 3 + 2] = p[2];
  }
  const indices = reversesOrientation(node) ? flipped(soup.indices) : soup.indices;
  return { ok: true, mesh: { positions: moved, indices }, sourceTriangles, edgeLength, maxChordError };
}

export interface WarpEstimate {
  /** Longest edge the refinement keeps (Infinity: none needed). */
  readonly edgeLength: number;
  /** Upper estimate of the triangles after refinement: about 2.3 area / h² over the triangles meeting the region. */
  readonly triangles: number;
}

/**
 * Edge length and triangle estimate of warping `source` by `node` at `tolerance` (no welding, no splitting: cheap).
 * @failure degenerate frame -> null
 */
export function estimateWarp(source: MeshData, node: DeformNode, tolerance: number): WarpEstimate | null {
  const warp = warpOf(node);
  if (warp === null) return null;
  const extent = localExtentOf(warp.frame, source.positions);
  const edgeLength = maxEdgeLength(node, extent, tolerance);
  const count = source.indices.length / 3;
  if (!Number.isFinite(edgeLength) || node.region === undefined) return { edgeLength, triangles: count };
  const { start, end } = node.region;
  let area = 0;
  for (let t = 0; t + 2 < source.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => at(source.positions, source.indices[t + k] as number));
    const heights = corners.map((p) => toLocal(warp.frame, p)[2]);
    if (node.region.infinite !== true && (Math.max(...heights) <= start || Math.min(...heights) >= end)) continue;
    const [a, b, c] = corners as [Vec3, Vec3, Vec3];
    const [u, w] = [sub(b, a), sub(c, a)];
    area += 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
  }
  return { edgeLength, triangles: Math.max((2.3 * area) / (edgeLength * edgeLength), count) };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function flipped(indices: ReadonlyArray<number>): number[] {
  const out = [...indices];
  for (let t = 0; t + 2 < out.length; t += 3) [out[t + 1], out[t + 2]] = [out[t + 2] as number, out[t + 1] as number];
  return out;
}
