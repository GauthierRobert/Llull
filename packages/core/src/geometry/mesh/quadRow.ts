/**
 * Boundary-aligned quad row for `quad_remesh` of open meshes (07 MSH FR-MSH-22, TECHNICAL_SPEC 13.28). QuadriFlow leaves a staircase along the boundary (vertices of valence 1 and 2 in
 * runs, corners wherever the staircase turns); snapping those vertices onto the rim (`snapQuadBoundary`) keeps the staircase and sometimes folds a quad. This step takes the outermost
 * layer of quads away, which leaves an inner boundary loop M, and puts in its place one row of quads between M and the rim: the rim resampled to as many points as M has vertices
 * (corners of the rim exact, the rest evenly spaced by arc length between them), each point joined to the vertex of M it is nearest to in order. The new boundary has no vertex of valence
 * 1 or 2 but at the rim's corners; the vertices of M are relaxed on the surface a few times.
 * @invariant the quads away from the boundary are the engine's, untouched but for the vertices of M (relaxed on the source surface); the strip quads wind like the inner quads they share an edge with
 * @failure a boundary the layer cannot be taken off (a pinch, loops that merge or vanish), loops that do not pair with the rim one for one, a strip that would fold -> a `SnapProblem`
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { faceNormal } from './quadCage';
import { type RimLoop, type SnapProblem, boundaryEdges, loopsOf, meanEdge, rimArc, rimLoop, rimPointAt } from './quadOpen';
import { SurfaceIndex } from './surfaceIndex';

const at = (positions: ReadonlyArray<number>, index: number): Vec3 => [
  positions[3 * index] as number,
  positions[3 * index + 1] as number,
  positions[3 * index + 2] as number,
];
const dist = (p: Vec3, q: Vec3): number => Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
const dot = (p: Vec3, q: Vec3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const problem = (cause: SnapProblem['cause'], message: string): SnapProblem => ({ cause, message });

/** Relaxation passes of the vertices of the inner boundary, and the weight of the neighbours' mean in each (the rest is the vertex). */
const RELAX_PASSES = 3;
const RELAX_WEIGHT = 0.5;
/** Shares of even spacing tried in turn (the rest follows the projection of the inner boundary onto the rim): the first row that does not fold wins. */
const EVENNESS = [1, 0.75, 0.5, 0.25, 0] as const;

export interface RowRealign {
  readonly positions: number[];
  readonly quads: number[];
  readonly loops: number;
  /** The largest distance from a new boundary vertex (on the rim) to the nearest vertex of the boundary the engine made: how far the boundary moved, not a deviation from the source. */
  readonly worstMove: number;
  readonly stripQuads: number;
  readonly removedQuads: number;
  /** The share of even spacing of the rim points (1 = evenly spaced by arc length, 0 = the projection of the inner boundary). */
  readonly evenness: number;
}

/** Evenly spaced rim points (arc lengths) and which of them are corners of the rim (index of the point -> index of the rim vertex). */
interface Resampled {
  readonly arcs: number[];
  readonly cornerAt: Map<number, number>;
}

/** `count` points on `rim`: its corners exactly, the rest evenly spaced by arc length between them (the counts per side by largest remainder, at least one per side). */
function resample(rim: RimLoop, count: number): Resampled | null {
  const corners = [...rim.corners].sort((x, y) => x.arc - y.arc);
  if (corners.length > count) return null;
  if (corners.length === 0) return { arcs: Array.from({ length: count }, (_, i) => (rim.length * i) / count), cornerAt: new Map() };
  const sides = corners.map((c, j) => {
    const next = corners[(j + 1) % corners.length] as { arc: number };
    const span = next.arc - c.arc + (j + 1 === corners.length ? rim.length : 0);
    return { start: c.arc, span: corners.length === 1 ? rim.length : span, corner: c.k };
  });
  const shares = sides.map((s) => (count * s.span) / rim.length);
  const counts = shares.map((s) => Math.max(1, Math.floor(s)));
  let extra = count - counts.reduce((a, b) => a + b, 0);
  const order = shares.map((s, j) => ({ j, rest: s - Math.floor(s) })).sort((x, y) => y.rest - x.rest || x.j - y.j);
  for (let guard = 0; extra !== 0 && guard < 4 * count; guard++) {
    const entry = order[guard % order.length] as { j: number };
    if (extra > 0) {
      counts[entry.j] = (counts[entry.j] as number) + 1;
      extra--;
    } else if ((counts[entry.j] as number) > 1) {
      counts[entry.j] = (counts[entry.j] as number) - 1;
      extra++;
    }
  }
  if (extra !== 0) return null;
  const arcs: number[] = [];
  const cornerAt = new Map<number, number>();
  sides.forEach((s, j) => {
    cornerAt.set(arcs.length, s.corner);
    for (let t = 0; t < (counts[j] as number); t++) arcs.push(s.start + (s.span * t) / (counts[j] as number));
  });
  return { arcs, cornerAt };
}

/** What does not depend on the share of even spacing, per boundary loop: the rim it follows, the partner of each inner vertex, the arcs the rim points are blended from. */
interface LoopPlan {
  readonly loop: number[];
  readonly rim: RimLoop;
  readonly n: number;
  readonly direction: number;
  readonly evenArc: number[];
  /** The arc of the projection of each inner vertex onto the rim, unwrapped next to its even arc. */
  readonly projected: number[];
  /** Index in the loop -> index of the rim vertex, for the vertices that sit at a corner of the rim. */
  readonly pinned: Map<number, number>;
}

/** The engine boundary loop whose vertices share a removed quad with a vertex of `loop`; null when none or several. */
function engineLoopOf(loop: number[], touching: Map<number, number[]>, engineLoopOfVertex: Map<number, number>): number | null {
  const found = new Set<number>();
  for (const v of loop)
    for (const w of touching.get(v) ?? []) if (engineLoopOfVertex.has(w)) found.add(engineLoopOfVertex.get(w) as number);
  return found.size === 1 ? ([...found][0] as number) : null;
}

/**
 * Replace the outermost layer of quads by one row between the inner boundary and the rim, for every boundary loop. See the module comment for the contract.
 * An inner loop is paired with the engine boundary loop it shares removed quads with, and that one with the rim loop most of its vertices are nearest to, one for one.
 */
export function realignBoundaryRow(
  source: MeshData,
  positions: ReadonlyArray<number>,
  quads: ReadonlyArray<number>,
  axis: number | null,
): RowRealign | SnapProblem {
  const sourceLoops = loopsOf(boundaryEdges(source.indices, 3));
  const quadLoops = loopsOf(boundaryEdges(quads, 4));
  if (sourceLoops === null)
    return problem('source', 'the boundary of the source is not a set of simple loops (an edge chain branches or does not close)');
  if (quadLoops === null) return problem('shape', "the boundary of the engine's quads is not a set of simple loops");
  if (sourceLoops.length !== quadLoops.length)
    return problem('loops', `the engine's quads have ${quadLoops.length} boundary loop(s) against ${sourceLoops.length} in the source`);
  const edge = meanEdge(positions, quads);
  const rims = sourceLoops.map((loop) => rimLoop(source, loop, axis, edge));
  const engineLoopOfVertex = new Map<number, number>();
  quadLoops.forEach((loop, id) => loop.forEach((v) => engineLoopOfVertex.set(v, id)));
  const touching = new Map<number, number[]>();
  const innerQuads: number[] = [];
  let removed = 0;
  for (let f = 0; f < quads.length / 4; f++) {
    const corners = [0, 1, 2, 3].map((k) => quads[4 * f + k] as number);
    if (corners.some((v) => engineLoopOfVertex.has(v))) {
      removed++;
      for (const v of corners) touching.set(v, [...(touching.get(v) ?? []), ...corners]);
    } else innerQuads.push(...corners);
  }
  if (innerQuads.length === 0) return problem('shape', 'no quad is left when the outermost layer is taken away');
  const innerLoops = loopsOf(boundaryEdges(innerQuads, 4));
  if (innerLoops === null || innerLoops.length !== quadLoops.length)
    return problem(
      'shape',
      'the outermost layer of quads cannot be taken away: the inner boundary is not one simple loop per boundary loop',
    );
  // engine boundary loop -> rim by the nearest rim of most of its vertices; inner loop -> engine boundary loop by the removed quads they share
  const rimOfEngineLoop = quadLoops.map((loop) => {
    const votes = new Map<number, number>();
    for (const v of loop) {
      const near = rims.map((rim, id) => ({ id, d: rimArc(rim, at(positions, v)).distance })).reduce((x, y) => (y.d < x.d ? y : x));
      votes.set(near.id, (votes.get(near.id) ?? 0) + 1);
    }
    return ([...votes.entries()].sort((x, y) => y[1] - x[1])[0] as [number, number])[0];
  });
  if (new Set(rimOfEngineLoop).size !== rimOfEngineLoop.length)
    return problem('loops', "two boundary loops of the engine's quads follow the same boundary loop of the source");
  const rows: Array<{ loop: number[]; rim: RimLoop }> = [];
  for (const loop of innerLoops) {
    const engineLoop = engineLoopOf(loop, touching, engineLoopOfVertex);
    if (engineLoop === null)
      return problem('loops', 'an inner boundary loop does not border exactly one boundary loop of the engine quads');
    rows.push({ loop, rim: rims[rimOfEngineLoop[engineLoop] as number] as RimLoop });
  }
  // vertices of the result: those of the inner quads, then the rim points
  const used = [...new Set(innerQuads)].sort((x, y) => x - y);
  const renumber = new Map(used.map((v, i) => [v, i]));
  const base: number[] = used.flatMap((v) => [...at(positions, v)]);
  const quadsOut = innerQuads.map((v) => renumber.get(v) as number);
  const oldBoundary = [...engineLoopOfVertex.keys()].map((v) => at(positions, v));
  const innerOfEdge = new Map<string, number>();
  for (let f = 0; f < quadsOut.length / 4; f++)
    for (let k = 0; k < 4; k++) innerOfEdge.set(`${quadsOut[4 * f + k]},${quadsOut[4 * f + ((k + 1) % 4)]}`, f);

  // the part of the work that does not depend on the share of even spacing: partners, strips, adjacency
  const plans: LoopPlan[] = [];
  const strips: number[] = [];
  let first = base.length / 3;
  for (const { loop, rim } of rows) {
    const n = loop.length;
    const even = resample(rim, n);
    if (even === null) return problem('shape', 'a boundary loop has fewer vertices than the corners of the rim it follows');
    const { arcs, cornerAt } = even;
    const rimPoints = arcs.map((arc) => rimPointAt(rim, arc));
    const inner = loop.map((v) => at(positions, v));
    // the partner of each inner vertex: the cyclic shift (and direction) of the evenly spaced points that brings them closest overall
    let best = { cost: Infinity, shift: 0, reversed: false };
    for (const reversed of [false, true])
      for (let shift = 0; shift < n; shift++) {
        let cost = 0;
        for (let i = 0; i < n; i++) {
          const d = dist(inner[i] as Vec3, rimPoints[reversed ? (((shift - i) % n) + n) % n : (shift + i) % n] as Vec3);
          cost += d * d;
        }
        if (cost < best.cost) best = { cost, shift, reversed };
      }
    const partner = (i: number): number => (best.reversed ? (((best.shift - i) % n) + n) % n : (best.shift + i) % n);
    const direction = best.reversed ? -1 : 1;
    const evenArc: number[] = [arcs[partner(0)] as number];
    for (let i = 1; i < n; i++) {
      const step = (((arcs[partner(i)] as number) - (arcs[partner(i - 1)] as number)) % rim.length) * direction;
      evenArc.push((evenArc[i - 1] as number) + direction * (((step % rim.length) + rim.length) % rim.length));
    }
    const wrap = (d: number): number => d - rim.length * Math.round(d / rim.length);
    const pinned = new Map<number, number>();
    const projected = evenArc.map((e, i) => {
      const corner = cornerAt.get(partner(i));
      if (corner !== undefined) pinned.set(i, corner);
      return e + wrap(rimArc(rim, inner[i] as Vec3).arc - e);
    });
    plans.push({ loop, rim, n, direction, evenArc, projected, pinned });
    for (let i = 0; i < n; i++) {
      const [a, b] = [loop[i] as number, loop[(i + 1) % n] as number];
      // the inner quad runs a -> b along this edge, so the strip quad runs b -> a
      strips.push(renumber.get(b) as number, renumber.get(a) as number, first + i, first + ((i + 1) % n));
    }
    first += n;
  }
  const all = [...quadsOut, ...strips];
  const index = new SurfaceIndex(source.positions, source.indices);
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    const known = neighbours.get(a);
    if (known === undefined) neighbours.set(a, new Set([b]));
    else known.add(b);
  };
  for (let f = 0; f < all.length / 4; f++)
    for (let k = 0; k < 4; k++) {
      const [a, b] = [all[4 * f + k] as number, all[4 * f + ((k + 1) % 4)] as number];
      link(a, b);
      link(b, a);
    }
  const sound = (coords: ReadonlyArray<number>): boolean => {
    for (let f = 0; f < all.length / 4; f++) if (!(Math.hypot(...faceNormal(coords, all, f)) > 0)) return false;
    for (let f = 0; f < quadsOut.length / 4; f++)
      if (!(dot(faceNormal(base, quadsOut, f), faceNormal(coords, quadsOut, f)) > 0)) return false;
    // each strip quad faces the way the inner quad it shares its edge with does (a staircase makes the strip quads non-convex, so no corner test)
    for (let s = 0; s < strips.length / 4; s++) {
      const strip = strips.slice(4 * s, 4 * s + 4);
      const neighbour = innerOfEdge.get(`${strip[1]},${strip[0]}`);
      if (neighbour !== undefined && !(dot(faceNormal(coords, strip, 0), faceNormal(coords, quadsOut, neighbour)) > 0)) return false;
    }
    return true;
  };
  const movable = plans.flatMap(({ loop }) => loop.map((v) => renumber.get(v) as number));

  /** The result for the share `lambda` of even spacing (1) against the projection of the inner vertices onto the rim (0), or why it fails. */
  const build = (lambda: number): RowRealign | string => {
    const out = base.slice();
    const rimVertices: number[] = [];
    for (const { rim, n, direction, evenArc, projected, pinned } of plans) {
      // the even arcs and the projections near them, blended; the corners stay exactly where they are
      const arc = evenArc.map((e, i) => (pinned.has(i) ? e : lambda * e + (1 - lambda) * (projected[i] as number)));
      const gap = (1e-3 * rim.length) / n;
      const ordered = (a: number, b: number): boolean => (direction > 0 ? b - a >= gap : a - b >= gap);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < n; i++)
          if (!ordered(arc[i - 1] as number, arc[i] as number) && !pinned.has(i)) arc[i] = (arc[i - 1] as number) + direction * gap;
        for (let i = n - 2; i >= 0; i--)
          if (!ordered(arc[i] as number, arc[i + 1] as number) && !pinned.has(i)) arc[i] = (arc[i + 1] as number) - direction * gap;
      }
      for (let i = 1; i < n; i++)
        if (!ordered(arc[i - 1] as number, arc[i] as number)) return 'the rim points cannot be put in order along the inner boundary';
      // once round the rim: the last point must stay a gap short of the first one
      if (rim.length - direction * ((arc[n - 1] as number) - (arc[0] as number)) < gap)
        return 'the rim points do not close once round the rim along the inner boundary';
      const start = out.length / 3;
      for (let i = 0; i < n; i++) {
        const corner = pinned.get(i);
        out.push(...(corner !== undefined ? (rim.points[corner] as Vec3) : rimPointAt(rim, arc[i] as number)));
        rimVertices.push(start + i);
      }
    }
    if (!sound(out)) return 'the row of quads between the inner boundary and the rim folds';
    // relax the inner boundary vertices on the surface; kept only when nothing folds
    let relaxed = out.slice();
    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      const next = relaxed.slice();
      for (const v of movable) {
        const around = [...(neighbours.get(v) ?? [])];
        const mean = around.reduce<Vec3>(
          (sum, w) => [
            sum[0] + (relaxed[3 * w] as number) / around.length,
            sum[1] + (relaxed[3 * w + 1] as number) / around.length,
            sum[2] + (relaxed[3 * w + 2] as number) / around.length,
          ],
          [0, 0, 0],
        );
        const p = at(relaxed, v);
        const hit = index.closest([
          p[0] + RELAX_WEIGHT * (mean[0] - p[0]),
          p[1] + RELAX_WEIGHT * (mean[1] - p[1]),
          p[2] + RELAX_WEIGHT * (mean[2] - p[2]),
        ]);
        next[3 * v] = hit.point[0];
        next[3 * v + 1] = hit.point[1];
        next[3 * v + 2] = hit.point[2];
      }
      relaxed = next;
    }
    const final = sound(relaxed) ? relaxed : out;
    let worstMove = 0;
    for (const v of rimVertices) {
      const p = at(final, v);
      worstMove = Math.max(
        worstMove,
        oldBoundary.reduce((m, q) => Math.min(m, dist(p, q)), Infinity),
      );
    }
    return {
      positions: final,
      quads: all,
      loops: rows.length,
      worstMove,
      stripQuads: strips.length / 4,
      removedQuads: removed,
      evenness: lambda,
    };
  };
  let why = 'the row of quads between the inner boundary and the rim folds';
  for (const lambda of EVENNESS) {
    const result = build(lambda);
    if (typeof result !== 'string') return result;
    why = result;
  }
  return problem('shape', why);
}
