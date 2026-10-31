/**
 * Exact G1 across the edges of the patches around extraordinary vertices (04 DIR §5.8, TECHNICAL_SPEC DES-4c exact G1): the linear form of tangent-plane continuity.
 * Across a shared edge the inward cross-boundary derivatives of the two bicubic patches satisfy D(t) = -a C(t) + beta(t) T(t), a constant and beta linear along the edge
 * (so every term is a cubic), T the tangent of the shared boundary: four vector equations on the Bezier coefficients m = 0..3. The scalars a, beta0, beta1 of an edge are fitted to the
 * start poles (6 equations, 3 unknowns) and kept; the equations are then LINEAR in the poles, the same system for x, y and z.
 * Stage 1 moves the four interior poles of the quads that touch an extraordinary vertex and keeps every boundary pole (the boundary curves never change). Where that system
 * has no solution (a valence-4 vertex beside ONE extraordinary vertex breaks the twist compatibility of its four edge conditions) stage 2 also moves the two inner poles of every
 * edge between two free quads, shared by the two patches (G0 stays exact), over the star and as many rings of quads around it as it takes: same patch count, same corner poles.
 * Among the poles that satisfy the conditions the solve takes those nearest to the limit surface (least squares on samples inside the solution set); a group of quads
 * whose conditions contradict each other has no solution at this degree and is reported, not approximated.
 * @invariant corner poles never move, nor any pole of an edge that has a quad outside the free set; pure; the poles of a consistent group satisfy every condition to rounding
 */

import type { Vec3 } from '../../model/types';
import type { BezierPatch } from '../subdivisionPatches';
import type { Cage } from '../subdivision';
import { DENSE_MAX_UNKNOWNS, type Sample, type SparseRow, gaussSolve, solveDense, solveSparse } from './g1Linear';
import { surfaceEvaluator } from './limit';
import { buildTopology } from './topology';

/** Pole indices (i * 4 + j) of side `k` of a patch: the boundary poles `b[m]` and the row next to them `r[m]`, m = 0..3 along the side (directed v_k -> v_k+1). */
function sidePoles(k: number): { b: number[]; r: number[] } {
  const m = [0, 1, 2, 3];
  if (k === 0) return { b: m.map((x) => x * 4), r: m.map((x) => x * 4 + 1) };
  if (k === 1) return { b: m.map((x) => 12 + x), r: m.map((x) => 8 + x) };
  if (k === 2) return { b: m.map((x) => (3 - x) * 4 + 3), r: m.map((x) => (3 - x) * 4 + 2) };
  return { b: m.map((x) => 3 - x), r: m.map((x) => 4 + 3 - x) };
}
const INTERIOR = [5, 6, 9, 10];
/** Rings of quads around the quads that touch an extraordinary vertex that stage 2 may free, at most. */
const MOST_RINGS = 3;
/** A factor a at or below this is a fold (the two patches lie on the same side of their edge) or no edge at all: the group is refused. */
const FOLDED = 1e-12;
/** Last resort of stage 2: free every quad of the cage when it has at most this many. */
const WHOLE_CAGE_QUADS = 400;
/** A group whose conditions are met to this fraction of the size of the cage is consistent (rounding of the solve is 1e-15). */
const CONSISTENT = 1e-9;
/** Samples per side of every free patch in the limit-surface objective. */
const SAMPLES = 4;
export interface ExactG1Group {
  readonly quads: number;
  /** The valences (other than 4) of the vertices of the quads in this group. */
  readonly valences: number[];
  /** Largest violation of a condition after the solve, relative to the size of the cage (the end conditions of the edges included). */
  readonly residual: number;
  /** Largest misfit of the end fit of a, beta0, beta1 to the START poles of an edge of this group, relative to the size of the cage (a diagnostic: the end rows are part of the system and are solved with the rest). */
  readonly endMisfit: number;
  readonly consistent: boolean;
  /** "solved", or why not: "contradiction" (the conditions have no common solution at this degree), "degenerate edge" (an edge without an end fit: no tangent, or a folded pair), "work budget" (too big for the bounded solve). */
  readonly reason: 'solved' | 'contradiction' | 'degenerate edge' | 'work budget';
  /** What the free poles approach inside the solution set: "limit" (the limit surface at samples, dense path) or "start" (the geometry poles: groups too big for the dense path). */
  readonly objective: 'limit' | 'start';
}

export interface ExactG1 {
  readonly patches: BezierPatch[];
  /** Connected groups of free quads and whether their conditions could be met (then their G1 holds to rounding). */
  readonly groups: ExactG1Group[];
  /** "boundary-kept": only interior poles moved; "edges-freed": the inner edge poles between free quads moved too; null: nothing to solve. */
  readonly method: 'boundary-kept' | 'edges-freed' | null;
  /** Quads whose poles may move (all patches keep their count and corner poles). */
  readonly freeQuads: number;
}

const dot = (p: readonly number[], q: readonly number[]): number => p.reduce((sum, v, i) => sum + v * (q[i] as number), 0);
const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];

/** One linear condition: sum of coefficient x unknown = rhs (per axis); `face` is the free quad the edge belongs to (the group it is counted in). */
interface Row {
  readonly terms: Array<readonly [number, number]>;
  readonly rhs: Vec3;
  readonly face: number;
}

const bernstein = (t: number): number[] => {
  const s = 1 - t;
  return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t];
};

interface Assembly {
  readonly start: Vec3[];
  /** (patch * 16 + pole) -> unknown. */
  readonly variableOf: Map<number, number>;
  readonly rows: Row[];
  /** Per free quad: the largest end-fit misfit of its edges, and whether one of them has no end fit at all. */
  readonly endMisfit: Map<number, number>;
  readonly degenerate: Set<number>;
}

/** The linear system of the conditions for the free quads `free`; with `edgesFree` the two inner poles of every edge between two free quads are unknowns too. */
function assemble(
  refined: Cage,
  patches: readonly BezierPatch[],
  topology: ReturnType<typeof buildTopology>,
  free: ReadonlySet<number>,
  edgesFree: boolean,
  scale: number,
): Assembly {
  const creased = new Set(refined.creases.flat());
  const pole = (f: number, index: number): Vec3 => (patches[f] as BezierPatch)[index] as Vec3;
  const variableOf = new Map<number, number>();
  const start: Vec3[] = [];
  const declare = (key: number, value: Vec3): number => {
    const known = variableOf.get(key);
    if (known !== undefined) return known;
    variableOf.set(key, start.length);
    start.push(value);
    return start.length - 1;
  };
  for (const f of [...free].sort((x, y) => x - y)) for (const p of INTERIOR) declare(f * 16 + p, pole(f, p));
  const sides = (edge: {
    a: number;
    b: number;
    faces: number[];
  }): { f: number; g: number; P: ReturnType<typeof sidePoles>; Q: ReturnType<typeof sidePoles> } => {
    const [f, g] = edge.faces as [number, number];
    const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
    return { f, g, P: sidePoles((refined.faces[f] as number[]).indexOf(from)), Q: sidePoles((refined.faces[g] as number[]).indexOf(to)) };
  };
  const usable = (edge: { a: number; b: number; faces: number[] }): boolean =>
    edge.faces.length === 2 && !creased.has(edge.a) && !creased.has(edge.b);
  if (edgesFree)
    for (const edge of topology.edges) {
      if (!usable(edge) || !free.has(edge.faces[0] as number) || !free.has(edge.faces[1] as number)) continue;
      const { f, g, P, Q } = sides(edge);
      for (const m of [1, 2])
        variableOf.set(g * 16 + (Q.b[3 - m] as number), declare(f * 16 + (P.b[m] as number), pole(f, P.b[m] as number)));
    }
  const rows: Row[] = [];
  const endMisfit = new Map<number, number>();
  const degenerate = new Set<number>();
  for (const edge of topology.edges) {
    if (!usable(edge) || (!free.has(edge.faces[0] as number) && !free.has(edge.faces[1] as number))) continue;
    const { f, g, P, Q } = sides(edge);
    const owner = free.has(f) ? f : g;
    const boundary = P.b.map((i) => pole(f, i));
    const scaled = (v: Vec3): Vec3 => [3 * v[0], 3 * v[1], 3 * v[2]];
    const C = P.r.map((i, m) => scaled(sub(pole(f, i), boundary[m] as Vec3)));
    const D = P.r.map((_, m) => scaled(sub(pole(g, Q.r[3 - m] as number), pole(g, Q.b[3 - m] as number))));
    const T = [0, 1, 2].map((m) => scaled(sub(boundary[m + 1] as Vec3, boundary[m] as Vec3)));
    const [C0, C3, D0, D3, T0, T2] = [C[0], C[3], D[0], D[3], T[0], T[2]] as [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
    // a, beta0, beta1 from the end conditions D0 + a C0 = beta0 T0 and D3 + a C3 = beta1 T2 (least squares, 6 equations, 3 unknowns)
    const columns: number[][] = [
      [...C0, ...C3],
      [-T0[0], -T0[1], -T0[2], 0, 0, 0],
      [0, 0, 0, -T2[0], -T2[1], -T2[2]],
    ];
    const target = [...D0, ...D3].map((v) => -v);
    const unknown = gaussSolve(
      columns.map((u) => columns.map((w) => dot(u, w))),
      columns.map((u) => dot(u, target)),
    );
    if (unknown === null || (unknown[0] as number) <= FOLDED) {
      for (const quad of [f, g]) if (free.has(quad)) degenerate.add(quad);
      continue;
    }
    const [a, b0, b1] = unknown as [number, number, number];
    for (let k = 0; k < 6; k++)
      endMisfit.set(
        owner,
        Math.max(
          endMisfit.get(owner) ?? 0,
          Math.abs(
            dot(
              columns.map((u) => u[k] as number),
              unknown,
            ) - (target[k] as number),
          ) / scale,
        ),
      );
    // coefficient m of beta(t) T(t) as weights on T0, T1, T2
    const weights: number[][] = [
      [b0, 0, 0],
      [b1 / 3, (2 * b0) / 3, 0],
      [0, (2 * b1) / 3, b0 / 3],
      [0, 0, b1],
    ];
    for (let m = 0; m < 4; m++) {
      const terms: Array<readonly [number, number]> = [];
      const constant = [0, 0, 0];
      const add = (face: number, index: number, coefficient: number): void => {
        const id = variableOf.get(face * 16 + index);
        if (id !== undefined) terms.push([id, coefficient]);
        else for (let k = 0; k < 3; k++) constant[k] = (constant[k] as number) + coefficient * (pole(face, index)[k] as number);
      };
      // D_m + a C_m - (beta T)_m = 0 with D_m = 3 (R^Q - B^Q), C_m = 3 (R^P - B^P), T_k = 3 (B_k+1 - B_k)
      add(g, Q.r[3 - m] as number, 3);
      add(g, Q.b[3 - m] as number, -3);
      add(f, P.r[m] as number, 3 * a);
      add(f, P.b[m] as number, -3 * a);
      (weights[m] as number[]).forEach((w, k) => {
        if (w === 0) return;
        add(f, P.b[k + 1] as number, -3 * w);
        add(f, P.b[k] as number, 3 * w);
      });
      rows.push({ terms, rhs: [-(constant[0] as number), -(constant[1] as number), -(constant[2] as number)], face: owner });
    }
  }
  return { start, variableOf, rows, endMisfit, degenerate };
}

/** Solves every connected group of an assembly; the poles of the consistent groups replace the originals in the returned patches. */
function solveAssembly(
  refined: Cage,
  patches: readonly BezierPatch[],
  free: ReadonlySet<number>,
  valence: ReadonlyArray<number>,
  assembly: Assembly,
  evaluate: ReturnType<typeof surfaceEvaluator>,
  scale: number,
  maxWork: number | undefined,
): { groups: ExactG1Group[]; out: Vec3[][] } {
  const { start, variableOf, rows } = assembly;
  const out: Vec3[][] = patches.map((patch) => patch.map((p): Vec3 => [p[0], p[1], p[2]]));
  const parent = start.map((_, i) => i);
  const find = (s: number): number => {
    let root = s;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    return root;
  };
  const join = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  const keysOf: number[][] = start.map(() => []);
  for (const [key, id] of variableOf) (keysOf[id] as number[]).push(key);
  const interior = (f: number): number[] => INTERIOR.map((p) => variableOf.get(f * 16 + p) as number);
  for (const f of free) for (const id of interior(f).slice(1)) join(interior(f)[0] as number, id);
  for (const row of rows)
    for (let i = 1; i < row.terms.length; i++)
      join((row.terms[0] as readonly [number, number])[0], (row.terms[i] as readonly [number, number])[0]);
  const groupOf = (f: number): number => find(interior(f)[0] as number);
  const facesOf = new Map<number, number[]>();
  for (const f of [...free].sort((x, y) => x - y)) facesOf.set(groupOf(f), [...(facesOf.get(groupOf(f)) ?? []), f]);
  const groups: ExactG1Group[] = [];
  for (const [owner, faces] of facesOf) {
    const mine = rows.filter((row) => groupOf(row.face) === owner);
    const withTerms = mine.filter((row) => row.terms.length > 0);
    const stuck = mine
      .filter((row) => row.terms.length === 0)
      .reduce((worst, row) => Math.max(worst, Math.abs(row.rhs[0]), Math.abs(row.rhs[1]), Math.abs(row.rhs[2])), 0);
    const touched = [...new Set([...faces.flatMap(interior), ...withTerms.flatMap((row) => row.terms.map((t) => t[0]))])].sort(
      (x, y) => x - y,
    );
    const column = new Map(touched.map((u, i) => [u, i]));
    const sparse: SparseRow[] = withTerms.map((row) => row.terms.map(([u, c]) => [column.get(u) as number, c] as const));
    const initial = touched.map((u) => start[u] as Vec3);
    const small = touched.length <= DENSE_MAX_UNKNOWNS;
    const samples: Sample[] = [];
    if (small)
      for (const f of faces)
        for (let i = 0; i < SAMPLES; i++)
          for (let j = 0; j < SAMPLES; j++) {
            const [u, v] = [(i + 0.5) / SAMPLES, (j + 0.5) / SAMPLES];
            const hit = evaluate(f, u, v);
            if (hit === null) continue;
            const [bu, bv] = [bernstein(u), bernstein(v)];
            const terms: Array<readonly [number, number]> = [];
            const offset = [0, 0, 0];
            for (let p = 0; p < 16; p++) {
              const w = (bu[Math.floor(p / 4)] as number) * (bv[p % 4] as number);
              const id = variableOf.get(f * 16 + p);
              if (id !== undefined && column.has(id)) terms.push([column.get(id) as number, w]);
              else
                for (let k = 0; k < 3; k++) offset[k] = (offset[k] as number) + w * (((patches[f] as BezierPatch)[p] as Vec3)[k] as number);
            }
            samples.push({ terms, constant: [offset[0] as number, offset[1] as number, offset[2] as number], target: hit.point });
          }
    const targets = withTerms.map((row) => row.rhs);
    const broken = faces.some((f) => assembly.degenerate.has(f));
    const solution = broken
      ? { x: initial, residual: Infinity, status: 'ok' as const }
      : small
        ? solveDense(sparse, targets, initial, samples, maxWork)
        : solveSparse(sparse, targets, initial, maxWork);
    const residual = Math.max(solution.residual, stuck) / scale;
    const endMisfit = Math.max(0, ...faces.map((f) => assembly.endMisfit.get(f) ?? 0));
    const consistent = !broken && solution.status === 'ok' && residual < CONSISTENT;
    const reason = consistent ? 'solved' : broken ? 'degenerate edge' : solution.status === 'budget' ? 'work budget' : 'contradiction';
    if (consistent)
      touched.forEach((u, i) => {
        for (const key of keysOf[u] as number[]) (out[Math.floor(key / 16)] as Vec3[])[key % 16] = solution.x[i] as Vec3;
      });
    const around = faces.flatMap((f) => (refined.faces[f] as number[]).map((v) => valence[v] as number)).filter((n) => n !== 4);
    groups.push({
      quads: faces.length,
      valences: [...new Set(around)].sort((x, y) => x - y),
      residual: broken ? Infinity : residual,
      endMisfit,
      consistent,
      reason,
      objective: small ? 'limit' : 'start',
    });
  }
  return { groups, out };
}

/**
 * Patches with the poles of the quads next to extraordinary vertices moved the least that makes every edge between such a quad and its neighbour exactly tangent-plane continuous.
 * `valence[v]` is the number of edges at v (4 for a boundary vertex). Quads at a crease vertex never move. A group of quads that cannot be made G1 at this degree keeps its
 * original poles and is reported.
 */
export function solveExactG1(
  refined: Cage,
  patches: readonly BezierPatch[],
  valence: ReadonlyArray<number>,
  options: { readonly mostRings?: number; readonly maxWork?: number } = {},
): ExactG1 {
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const creased = new Set(refined.creases.flat());
  const blocked = (f: number): boolean => (refined.faces[f] as number[]).some((v) => creased.has(v));
  const star = new Set<number>();
  refined.faces.forEach((face, f) => {
    if (face.some((v) => valence[v] !== 4) && !blocked(f)) star.add(f);
  });
  const original: ExactG1 = { patches: patches.map((p) => p.map((q): Vec3 => [q[0], q[1], q[2]])), groups: [], method: null, freeQuads: 0 };
  if (star.size === 0) return original;
  let low = [Infinity, Infinity, Infinity];
  let high = [-Infinity, -Infinity, -Infinity];
  for (const p of refined.vertices) {
    low = low.map((l, k) => Math.min(l, p[k] as number));
    high = high.map((h, k) => Math.max(h, p[k] as number));
  }
  const scale = Math.max(Math.hypot(...high.map((h, k) => h - (low[k] as number))), 1e-300);
  const evaluate = surfaceEvaluator(refined);
  const attempt = (free: ReadonlySet<number>, edgesFree: boolean): ExactG1 => {
    const solved = solveAssembly(
      refined,
      patches,
      free,
      valence,
      assemble(refined, patches, topology, free, edgesFree, scale),
      evaluate,
      scale,
      options.maxWork,
    );
    return {
      patches: solved.out.map((p) => p as BezierPatch),
      groups: solved.groups,
      method: edgesFree ? 'edges-freed' : 'boundary-kept',
      freeQuads: free.size,
    };
  };
  let best = attempt(star, false);
  if (best.groups.every((g) => g.consistent)) return best;
  // stage 2: the inner poles of the edges between free quads move too, over the star and as many rings around it as it takes
  const sizes = new Set<number>();
  const free = new Set(star);
  for (let rings = 1; rings <= (options.mostRings ?? MOST_RINGS); rings++) {
    for (const f of [...free])
      for (const v of refined.faces[f] as number[]) for (const g of topology.vertexFaces[v] as number[]) if (!blocked(g)) free.add(g);
    if (sizes.has(free.size)) continue;
    sizes.add(free.size);
    best = attempt(new Set(free), true);
    if (best.groups.every((g) => g.consistent)) return best;
  }
  const everything = new Set(refined.faces.map((_, f) => f).filter((f) => !blocked(f)));
  if (everything.size > free.size && everything.size <= WHOLE_CAGE_QUADS) best = attempt(everything, true);
  return best;
}
