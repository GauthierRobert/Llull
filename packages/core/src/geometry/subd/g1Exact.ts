/**
 * Exact G1 across the edges of the patches around extraordinary vertices (04 DIR §5.8, TECHNICAL_SPEC DES-4c exact G1): the linear form of tangent-plane continuity.
 * Across a shared edge the inward cross-boundary derivatives of the two bicubic patches satisfy D(t) = -a C(t) + beta(t) T(t), a constant and beta linear along the edge
 * (so every term is a cubic), T the tangent of the shared boundary. The two end coefficients of that condition only involve poles that never move (the cross poles at the ends of
 * an edge are boundary poles of the neighbouring edges), so a, beta0 and beta1 are fitted to them first; the two middle coefficients are then LINEAR in the interior poles
 * (1,1), (2,1), (1,2), (2,2) of the quads, the same system for x, y and z. The poles nearest to the geometry patches that satisfy it are the minimum-norm correction of the
 * rows of the system that are independent; a group of quads whose rows contradict each other has no solution at this degree and is reported, not approximated.
 * @invariant boundary poles never move (G0 stays exact); pure; the poles of a consistent group satisfy every condition to rounding
 */

import type { Vec3 } from '../../model/types';
import type { BezierPatch } from '../subdivisionPatches';
import type { Cage } from '../subdivision';
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
/** Rings of quads around the quads that touch an extraordinary vertex that may move too, at most: the star alone is over-determined by the regular patches around it. */
/** A group whose conditions are met to this fraction of the size of the cage is consistent (rounding of the solve is 1e-15). */
const CONSISTENT = 1e-9;

export interface ExactG1Group {
  readonly quads: number;
  /** The valences (other than 4) of the vertices of the quads in this group. */
  readonly valences: number[];
  /** Largest violation of a condition after the solve, relative to the size of the cage. */
  readonly residual: number;
  readonly consistent: boolean;
}

export interface ExactG1 {
  readonly patches: BezierPatch[];
  /** Connected groups of free quads and whether their conditions could be met (then their G1 holds to rounding). */
  readonly groups: ExactG1Group[];
  /** Largest relative misfit of the end conditions of an edge (a, beta0, beta1 fitted to the fixed poles): 0 when every edge is tangent-plane consistent at its ends. */
  readonly endMisfit: number;
}

const dot = (p: readonly number[], q: readonly number[]): number => p.reduce((s, v, i) => s + v * (q[i] as number), 0);
const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];

/** Solves `m x = r` by Gaussian elimination with partial pivoting; null when singular. */
function gaussSolve(m: number[][], r: number[]): number[] | null {
  const n = r.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let i = c + 1; i < n; i++)
      if (Math.abs((m[i] as number[])[c] as number) > Math.abs((m[pivot] as number[])[c] as number)) pivot = i;
    if (Math.abs((m[pivot] as number[])[c] as number) < 1e-300) return null;
    [m[c], m[pivot]] = [m[pivot] as number[], m[c] as number[]];
    [r[c], r[pivot]] = [r[pivot] as number, r[c] as number];
    for (let i = c + 1; i < n; i++) {
      const factor = ((m[i] as number[])[c] as number) / ((m[c] as number[])[c] as number);
      for (let k = c; k < n; k++) (m[i] as number[])[k] = ((m[i] as number[])[k] as number) - factor * ((m[c] as number[])[k] as number);
      r[i] = (r[i] as number) - factor * (r[c] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = r[i] as number;
    for (let k = i + 1; k < n; k++) sum -= ((m[i] as number[])[k] as number) * (x[k] as number);
    x[i] = sum / ((m[i] as number[])[i] as number);
  }
  return x;
}

/**
 * The x nearest to `start` with A x = b (b has three columns, one per axis; the same A), through the independent rows of A. `residual` is the largest violation of any row:
 * above rounding when the rows contradict each other (no solution).
 */
function minimumNorm(a: number[][], b: Vec3[], start: Vec3[]): { x: Vec3[]; residual: number } {
  const n = start.length;
  // independent rows by Gram-Schmidt (a row that the kept ones already span is dropped)
  const basis: number[][] = [];
  const kept: number[] = [];
  a.forEach((row, i) => {
    const w = row.slice();
    for (const q of basis) {
      const c = dot(w, q);
      for (let k = 0; k < n; k++) w[k] = (w[k] as number) - c * (q[k] as number);
    }
    const length = Math.sqrt(dot(w, w));
    if (length > 1e-9 * Math.max(Math.sqrt(dot(row, row)), 1e-300)) {
      basis.push(w.map((v) => v / length));
      kept.push(i);
    }
  });
  const gram = kept.map((i) => kept.map((j) => dot(a[i] as number[], a[j] as number[])));
  const columns: number[][] = [[], [], []];
  for (let axis = 0; axis < 3; axis++) {
    const current = start.map((p) => p[axis] as number);
    const rest = kept.map((i) => ((b[i] as Vec3)[axis] as number) - dot(a[i] as number[], current));
    const y = gaussSolve(
      gram.map((row) => row.slice()),
      rest,
    );
    if (y === null) return { x: start, residual: Infinity };
    columns[axis] = current.map(
      (value, k) => value + kept.reduce((sum, row, m) => sum + ((a[row] as number[])[k] as number) * (y[m] as number), 0),
    );
  }
  const x = start.map((_, k): Vec3 => [columns[0]?.[k] as number, columns[1]?.[k] as number, columns[2]?.[k] as number]);
  let residual = 0;
  a.forEach((row, i) => {
    for (let axis = 0; axis < 3; axis++)
      residual = Math.max(residual, Math.abs(dot(row, columns[axis] as number[]) - ((b[i] as Vec3)[axis] as number)));
  });
  return { x, residual };
}

/** One linear condition on the free poles: sum of coefficient x unknown = rhs (per axis). */
interface Condition {
  readonly terms: ReadonlyArray<readonly [number, number]>;
  readonly rhs: Vec3;
}

/**
 * Patches with the interior poles of the quads next to extraordinary vertices moved the least that makes every edge between such a quad and its neighbour exactly tangent-plane continuous. `valence[v]` is the number of edges at v (4 for a boundary vertex). Quads at a crease vertex
 * never move. A group of moved quads that cannot be made G1 at this degree keeps its original poles and is reported.
 */
export function solveExactG1(refined: Cage, patches: readonly BezierPatch[], valence: ReadonlyArray<number>): ExactG1 {
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const creased = new Set(refined.creases.flat());
  const blocked = (f: number): boolean => (refined.faces[f] as number[]).some((v) => creased.has(v));
  const star = new Set<number>();
  refined.faces.forEach((face, f) => {
    if (face.some((v) => valence[v] !== 4) && !blocked(f)) star.add(f);
  });
  let low = [Infinity, Infinity, Infinity];
  let high = [-Infinity, -Infinity, -Infinity];
  for (const p of refined.vertices) {
    low = low.map((l, k) => Math.min(l, p[k] as number));
    high = high.map((h, k) => Math.max(h, p[k] as number));
  }
  const scale = Math.max(Math.hypot(...high.map((h, k) => h - (low[k] as number))), 1e-300);
  return solveFor(refined, patches, valence, topology, star, scale);
}

function solveFor(
  refined: Cage,
  patches: readonly BezierPatch[],
  valence: ReadonlyArray<number>,
  topology: ReturnType<typeof buildTopology>,
  free: ReadonlySet<number>,
  scale: number,
): ExactG1 {
  const creased = new Set(refined.creases.flat());
  const out: Vec3[][] = patches.map((patch) => patch.map((p): Vec3 => [p[0], p[1], p[2]]));
  const freeList = [...free].sort((a, b) => a - b);
  const unknownOf = new Map<number, number>();
  freeList.forEach((f, s) => INTERIOR.forEach((p, k) => unknownOf.set(f * 16 + p, s * 4 + k)));
  const start: Vec3[] = freeList.flatMap((f) => INTERIOR.map((p) => (patches[f] as BezierPatch)[p] as Vec3));
  const pole = (f: number, index: number): Vec3 => (patches[f] as BezierPatch)[index] as Vec3;
  const conditions: Condition[] = [];
  let endMisfit = 0;
  const parent = freeList.map((_, s) => s);
  const find = (s: number): number => {
    let root = s;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    parent[s] = root;
    return root;
  };
  for (const edge of topology.edges) {
    if (edge.faces.length !== 2 || creased.has(edge.a) || creased.has(edge.b)) continue;
    const [f, g] = edge.faces as [number, number];
    if (!free.has(f) && !free.has(g)) continue;
    const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
    const P = sidePoles((refined.faces[f] as number[]).indexOf(from));
    const Q = sidePoles((refined.faces[g] as number[]).indexOf(to));
    const boundary = P.b.map((i) => pole(f, i));
    const scaled = (v: Vec3): Vec3 => [3 * v[0], 3 * v[1], 3 * v[2]];
    const C = P.r.map((i, m) => scaled(sub(pole(f, i), boundary[m] as Vec3)));
    // Q runs the other way round the shared edge: its pole m' = 3 - m
    const D = P.r.map((_, m) => scaled(sub(pole(g, Q.r[3 - m] as number), pole(g, Q.b[3 - m] as number))));
    const T = [0, 1, 2].map((m) => scaled(sub(boundary[m + 1] as Vec3, boundary[m] as Vec3)));
    const [C0, C3, D0, D3, T0, T1, T2] = [C[0], C[3], D[0], D[3], T[0], T[1], T[2]] as [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
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
    if (unknown === null) continue;
    const [a, b0, b1] = unknown as [number, number, number];
    for (let k = 0; k < 6; k++)
      endMisfit = Math.max(
        endMisfit,
        Math.abs(
          dot(
            columns.map((u) => u[k] as number),
            unknown,
          ) - (target[k] as number),
        ) / scale,
      );
    for (const m of [1, 2]) {
      // coefficient m of beta(t) T(t): m = 1 -> (2 b0 T1 + b1 T0) / 3, m = 2 -> (b0 T2 + 2 b1 T1) / 3
      const betaT: Vec3 =
        m === 1
          ? ([0, 1, 2].map((k) => (2 * b0 * (T1[k] as number) + b1 * (T0[k] as number)) / 3) as unknown as Vec3)
          : ([0, 1, 2].map((k) => (b0 * (T2[k] as number) + 2 * b1 * (T1[k] as number)) / 3) as unknown as Vec3);
      // 3 R^Q + 3 a R^P = 3 (1 + a) B_m + beta T, the poles that do not move taken to the right
      const terms: Array<readonly [number, number]> = [];
      const constant = [0, 0, 0];
      const add = (face: number, index: number, coefficient: number): void => {
        const u = unknownOf.get(face * 16 + index);
        if (u !== undefined) terms.push([u, coefficient]);
        else for (let k = 0; k < 3; k++) constant[k] = (constant[k] as number) + coefficient * (pole(face, index)[k] as number);
      };
      add(g, Q.r[3 - m] as number, 3);
      add(f, P.r[m] as number, 3 * a);
      const rhs = [0, 1, 2].map(
        (k) => 3 * (1 + a) * ((boundary[m] as Vec3)[k] as number) + (betaT[k] as number) - (constant[k] as number),
      ) as unknown as Vec3;
      conditions.push({ terms, rhs });
      const owners = [f, g].filter((q) => free.has(q)).map((q) => freeList.indexOf(q));
      if (owners.length === 2) parent[find(owners[0] as number)] = find(owners[1] as number);
    }
  }
  const rowsOf = new Map<number, number[]>();
  conditions.forEach((condition, row) => {
    const first = condition.terms[0];
    if (first === undefined) return;
    const owner = find(Math.floor(first[0] / 4));
    rowsOf.set(owner, [...(rowsOf.get(owner) ?? []), row]);
  });
  const solvedPoles = start.map((p): Vec3 => [p[0], p[1], p[2]]);
  const residualOf = new Map<number, number>();
  for (const [owner, rows] of rowsOf) {
    const touched = [...new Set(rows.flatMap((row) => (conditions[row] as Condition).terms.map((t) => t[0])))].sort((x, y) => x - y);
    const column = new Map(touched.map((u, i) => [u, i]));
    const dense = rows.map((row) => {
      const line = new Array<number>(touched.length).fill(0);
      for (const [u, c] of (conditions[row] as Condition).terms)
        line[column.get(u) as number] = (line[column.get(u) as number] as number) + c;
      return line;
    });
    const solution = minimumNorm(
      dense,
      rows.map((row) => (conditions[row] as Condition).rhs),
      touched.map((u) => start[u] as Vec3),
    );
    residualOf.set(owner, solution.residual / scale);
    if (solution.residual / scale < CONSISTENT) touched.forEach((u, i) => (solvedPoles[u] = solution.x[i] as Vec3));
  }
  freeList.forEach((f, s) => INTERIOR.forEach((p, k) => ((out[f] as Vec3[])[p] = solvedPoles[s * 4 + k] as Vec3)));
  const members = new Map<number, number[]>();
  freeList.forEach((_, s) => members.set(find(s), [...(members.get(find(s)) ?? []), s]));
  const groups: ExactG1Group[] = [...members.entries()].map(([owner, list]) => {
    const residual = residualOf.get(owner) ?? 0;
    const around = list
      .flatMap((s) => (refined.faces[freeList[s] as number] as number[]).map((v) => valence[v] as number))
      .filter((n) => n !== 4);
    return { quads: list.length, valences: [...new Set(around)].sort((x, y) => x - y), residual, consistent: residual < CONSISTENT };
  });
  return { patches: out, groups, endMisfit };
}
