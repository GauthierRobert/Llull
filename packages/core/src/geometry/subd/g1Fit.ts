/**
 * Tangent-plane fit of the Loop-Schaefer patches around extraordinary vertices (04 DIR §5.8, TECHNICAL_SPEC DES-4c): the boundary poles of every patch are shared with its
 * neighbours (G0 stays exact), so only the four interior poles of each quad that touches an extraordinary vertex are free. They are found by Levenberg-Marquardt so that the
 * unit normals of the two patches on both sides of every edge of such a quad agree at seven stations along the edge (the residual of tangent-plane continuity),
 * with a small pull towards the geometry patch so the surface stays near the Catmull-Clark limit. Quads are coupled through the edges they share, so each connected group
 * of them is one least-squares problem. A construction that is exactly G1 around a vertex of valence n needs more than the one bicubic patch per quad this keeps (Peters, 2000, uses
 * 3n); the fit reports what it reached, it does not claim zero.
 * @invariant boundary poles never move (G0 gaps stay 0); the result is a function of the patches alone (fixed order, fixed iterations)
 */

import type { Vec3 } from '../../model/types';
import { cross3, normalize3OrZero, sub3 } from '../../lib/vec3';
import type { BezierPatch } from '../subdivisionPatches';
import type { Cage } from '../subdivision';
import { buildTopology } from './topology';

/** Stations along an edge (shares of its length) where the normals are compared. */
const STATIONS = [1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8];
const ITERATIONS = 20;
/** Weight of the pull of the interior poles towards the geometry patch, relative to the normal residual (document-size scaled). */
const PULL = 0.1;
const INTERIOR: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 1],
  [1, 2],
  [2, 2],
];

const bernstein = (t: number): number[] => {
  const s = 1 - t;
  return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t];
};
const bernsteinDerivative = (t: number): number[] => {
  const s = 1 - t;
  return [-3 * s * s, 3 * s * s - 6 * t * s, 6 * t * s - 3 * t * t, 3 * t * t];
};

/** The Bernstein values and derivatives at (u, v): what the normal at that parameter needs. */
interface Basis {
  readonly bu: number[];
  readonly bv: number[];
  readonly du: number[];
  readonly dv: number[];
}
const basisAt = (u: number, v: number): Basis => ({
  bu: bernstein(u),
  bv: bernstein(v),
  du: bernsteinDerivative(u),
  dv: bernsteinDerivative(v),
});

/** Unit normal of `patch` at the parameter of `basis` (analytic derivatives; zero vector at a degenerate point). */
function normalAt(patch: readonly Vec3[], { bu, bv, du, dv }: Basis): Vec3 {
  let [ux, uy, uz, vx, vy, vz] = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const p = patch[i * 4 + j] as Vec3;
      const [a, b] = [(du[i] as number) * (bv[j] as number), (bu[i] as number) * (dv[j] as number)];
      [ux, uy, uz] = [ux + a * p[0], uy + a * p[1], uz + a * p[2]];
      [vx, vy, vz] = [vx + b * p[0], vy + b * p[1], vz + b * p[2]];
    }
  return normalize3OrZero(cross3([ux, uy, uz], [vx, vy, vz]));
}

/** Parameter of side `k` (directed v_k -> v_k+1) of a patch at fraction t along it. */
const sideParameter = (k: number, t: number): readonly [number, number] =>
  k === 0 ? [t, 0] : k === 1 ? [1, t] : k === 2 ? [1 - t, 1] : [0, 1 - t];

interface Seam {
  readonly faces: readonly [number, number];
  /** The bases of the stations on both sides of the seam, station by station. */
  readonly bases: ReadonlyArray<readonly [Basis, Basis]>;
}

/** Solves the dense symmetric positive system `a x = b` (Gaussian elimination with partial pivoting); `a` is destroyed. */
function solveDense(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs((a[r] as number[])[c] as number) > Math.abs((a[pivot] as number[])[c] as number)) pivot = r;
    if (Math.abs((a[pivot] as number[])[c] as number) < 1e-300) return null;
    [a[c], a[pivot]] = [a[pivot] as number[], a[c] as number[]];
    [b[c], b[pivot]] = [b[pivot] as number, b[c] as number];
    for (let r = c + 1; r < n; r++) {
      const f = ((a[r] as number[])[c] as number) / ((a[c] as number[])[c] as number);
      for (let k = c; k < n; k++) (a[r] as number[])[k] = ((a[r] as number[])[k] as number) - f * ((a[c] as number[])[k] as number);
      b[r] = (b[r] as number) - f * (b[c] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r] as number;
    for (let k = r + 1; k < n; k++) s -= ((a[r] as number[])[k] as number) * (x[k] as number);
    x[r] = s / ((a[r] as number[])[r] as number);
  }
  return x;
}

/**
 * Patches with the interior poles of every quad that touches an extraordinary vertex fitted to the tangent plane of its neighbours; the others are returned as given.
 * @invariant only interior poles (1,1), (2,1), (1,2), (2,2) of such quads change
 */
export function fitTangentPlanes(refined: Cage, patches: readonly BezierPatch[], valence: ReadonlyArray<number>): BezierPatch[] {
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const star = new Set<number>();
  refined.faces.forEach((face, f) => {
    if (face.some((v) => valence[v] !== 4)) star.add(f);
  });
  const seams: Seam[] = [];
  for (const edge of topology.edges) {
    if (edge.faces.length !== 2) continue;
    const [f, g] = edge.faces as [number, number];
    if (!star.has(f) && !star.has(g)) continue;
    const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
    const sides: readonly [number, number] = [(refined.faces[f] as number[]).indexOf(from), (refined.faces[g] as number[]).indexOf(to)];
    seams.push({
      faces: [f, g],
      bases: STATIONS.map((t) => [basisAt(...sideParameter(sides[0], t)), basisAt(...sideParameter(sides[1], 1 - t))] as const),
    });
  }
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as number;
    return r;
  };
  for (const seam of seams) if (star.has(seam.faces[0]) && star.has(seam.faces[1])) parent.set(find(seam.faces[0]), find(seam.faces[1]));
  const groups = new Map<number, number[]>();
  for (const f of [...star].sort((a, b) => a - b)) groups.set(find(f), [...(groups.get(find(f)) ?? []), f]);
  const out: Vec3[][] = patches.map((patch) => patch.map((p): Vec3 => [p[0], p[1], p[2]]));
  const diag = refined.vertices.reduce((m, p) => Math.max(m, Math.hypot(p[0], p[1], p[2])), 1e-300);
  const pull = PULL * diag;
  for (const group of groups.values()) {
    const members = new Set(group);
    const mine = seams.filter((seam) => members.has(seam.faces[0]) || members.has(seam.faces[1]));
    const rowsPerSeam = STATIONS.length * 3;
    const unknowns = group.length * 12;
    const start = group.flatMap((f) => INTERIOR.flatMap(([i, j]) => [...((out[f] as Vec3[])[i * 4 + j] as Vec3)]));
    const apply = (x: ReadonlyArray<number>, only?: number): void =>
      group.forEach((f, gi) => {
        if (only !== undefined && gi !== only) return;
        INTERIOR.forEach(
          ([i, j], m) =>
            ((out[f] as Vec3[])[i * 4 + j] = [
              x[gi * 12 + m * 3] as number,
              x[gi * 12 + m * 3 + 1] as number,
              x[gi * 12 + m * 3 + 2] as number,
            ]),
        );
      });
    const seamResidual = (seam: Seam): number[] => {
      const r: number[] = [];
      for (const [first, second] of seam.bases) {
        const d = sub3(normalAt(out[seam.faces[0]] as Vec3[], first), normalAt(out[seam.faces[1]] as Vec3[], second));
        r.push(d[0], d[1], d[2]);
      }
      return r;
    };
    const seamRows = (x: ReadonlyArray<number>): number[] => {
      apply(x);
      return mine.flatMap(seamResidual);
    };
    const pullRows = (x: ReadonlyArray<number>): number[] => x.map((value, k) => (pull * (value - (start[k] as number))) / diag);
    let x = [...start];
    let r = [...seamRows(x), ...pullRows(x)];
    let cost = r.reduce((sum, v) => sum + v * v, 0);
    let mu = 1e-3;
    const h = 1e-6 * diag;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      // the Jacobian by central differences: a pole of one quad changes only the seams of that quad
      const jacobian: number[][] = r.map(() => new Array<number>(unknowns).fill(0));
      group.forEach((f, gi) => {
        const touching = mine.map((seam, si) => [seam, si] as const).filter(([seam]) => seam.faces[0] === f || seam.faces[1] === f);
        for (let k = gi * 12; k < gi * 12 + 12; k++) {
          const [up, down] = [[...x], [...x]];
          up[k] = (up[k] as number) + h;
          down[k] = (down[k] as number) - h;
          apply(up, gi);
          const plus = touching.map(([seam]) => seamResidual(seam));
          apply(down, gi);
          const minus = touching.map(([seam]) => seamResidual(seam));
          touching.forEach(([, si], ti) => {
            for (let row = 0; row < rowsPerSeam; row++)
              (jacobian[si * rowsPerSeam + row] as number[])[k] =
                (((plus[ti] as number[])[row] as number) - ((minus[ti] as number[])[row] as number)) / (2 * h);
          });
          (jacobian[mine.length * rowsPerSeam + k] as number[])[k] = pull / diag;
        }
        apply(x, gi);
      });
      // J^T J from the rows' non-zero columns only: a seam row sees the unknowns of its two quads
      const normal = Array.from({ length: unknowns }, () => new Array<number>(unknowns).fill(0));
      jacobian.forEach((row, i) => {
        const seam = i < mine.length * rowsPerSeam ? (mine[Math.floor(i / rowsPerSeam)] as Seam) : null;
        const columns =
          seam === null
            ? [i - mine.length * rowsPerSeam]
            : seam.faces.flatMap((f) => (members.has(f) ? Array.from({ length: 12 }, (_, m) => group.indexOf(f) * 12 + m) : []));
        for (const p of columns) {
          const rp = row[p] as number;
          if (rp === 0) continue;
          for (const q of columns) (normal[p] as number[])[q] = ((normal[p] as number[])[q] as number) + rp * (row[q] as number);
        }
      });
      const gradient = Array.from(
        { length: unknowns },
        (_, p) => -jacobian.reduce((sum, row, i) => sum + (row[p] as number) * (r[i] as number), 0),
      );
      let accepted = false;
      for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
        const damped = normal.map((row, p) => row.map((value, q) => (p === q ? value + mu * Math.max(value, 1e-12) : value)));
        const step = solveDense(damped, [...gradient]);
        if (step === null) {
          mu *= 10;
          continue;
        }
        const trial = x.map((value, k) => value + (step[k] as number));
        const rt = [...seamRows(trial), ...pullRows(trial)];
        const trialCost = rt.reduce((sum, v) => sum + v * v, 0);
        if (trialCost < cost) {
          const gain = (cost - trialCost) / cost;
          [x, r, cost, mu, accepted] = [trial, rt, trialCost, Math.max(mu / 3, 1e-12), true];
          if (gain < 1e-6) iteration = ITERATIONS;
        } else mu *= 10;
      }
      if (!accepted) break;
    }
    apply(x);
  }
  return out;
}
