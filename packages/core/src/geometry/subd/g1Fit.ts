/**
 * Tangent-plane fit of the Loop-Schaefer patches around extraordinary vertices (04 DIR §5.8, TECHNICAL_SPEC DES-4c): the boundary poles of every patch are shared with its
 * neighbours (G0 stays exact), so only the four interior poles of each quad that touches an extraordinary vertex are free. They are found by Levenberg-Marquardt so that the
 * unit normals of the two patches on both sides of every edge of such a quad agree at seven stations along the edge (the residual of tangent-plane continuity),
 * with a small pull towards the geometry patch so the surface stays near the Catmull-Clark limit. Quads are coupled through the edges they share, so each quad is fitted against its neighbours' current poles. A construction that is exactly G1 around a vertex of valence n needs more than the one bicubic patch per quad this keeps (Peters, 2000, uses
 * 3n); the fit reports what it reached, it does not claim zero.
 * @invariant boundary poles never move (G0 gaps stay 0); the result is a function of the patches alone (fixed order, fixed iterations)
 */

import type { Vec3 } from '../../model/types';
import { cross3, dot3, normalize3OrZero, sub3 } from '../../lib/vec3';
import type { BezierPatch } from '../subdivisionPatches';
import type { Cage } from '../subdivision';
import { buildTopology } from './topology';

/** Stations along an edge (shares of its length) where the normals are compared. */
const STATIONS = [1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8];
/** Sweeps over the quads, and Levenberg-Marquardt iterations per quad per sweep: fixed, so the cost is linear in the number of quads and the result deterministic. */
/** A step may raise the largest normal angle at the guard stations by 25 %, or up to this many radians (0.5 degrees), never more. */
const FOLD_FLOOR = 0.0087;
const SWEEPS = 6;
const BLOCK_ITERATIONS = 3;
/** Weight of the pull of the interior poles towards the geometry patch (a distance divided by the extent of the cage) against the normal residual (dimensionless). */
const PULL = 0.35;
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

/** Stations of the normal-angle guard and of the reported break: 32 odd multiples of 1/64, none of them a station of the fit (multiples of 1/8). */
export const MEASURE_STATIONS = Array.from({ length: 32 }, (_, k) => (2 * k + 1) / 64);

interface Seam {
  readonly faces: readonly [number, number];
  /** The bases of the stations on both sides of the seam, station by station. */
  readonly bases: ReadonlyArray<readonly [Basis, Basis]>;
  /** The same at `MEASURE_STATIONS`: a step that raises the angle there is a fold the sparse stations did not see. */
  readonly guard: ReadonlyArray<readonly [Basis, Basis]>;
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
 * Block Gauss-Seidel: a few sweeps over the quads, each quad solving its own 12 unknowns against the current poles of its neighbours, so the cost is linear in the
 * number of quads (a dense solve per connected star grew with its cube). The quads and edges that touch a crease vertex are left as the geometry patches make them: an intentional crease (and its end) is not a break to remove.
 * @invariant only interior poles (1,1), (2,1), (1,2), (2,2) of such quads change; the pull is scaled by the extent of the cage, so the result does not depend on units or position
 */
export function fitTangentPlanes(refined: Cage, patches: readonly BezierPatch[], valence: ReadonlyArray<number>): BezierPatch[] {
  const topology = buildTopology(refined.vertices.length, refined.faces);
  const star = new Set<number>();
  const creased = new Set(refined.creases.flat());
  refined.faces.forEach((face, f) => {
    if (face.some((v) => valence[v] !== 4) && !face.some((v) => creased.has(v))) star.add(f);
  });
  const seamsOf = new Map<number, Seam[]>();
  for (const edge of topology.edges) {
    if (edge.faces.length !== 2 || creased.has(edge.a) || creased.has(edge.b)) continue;
    const [f, g] = edge.faces as [number, number];
    if (!star.has(f) && !star.has(g)) continue;
    const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
    const sides: readonly [number, number] = [(refined.faces[f] as number[]).indexOf(from), (refined.faces[g] as number[]).indexOf(to)];
    const seam: Seam = {
      faces: [f, g],
      bases: STATIONS.map((t) => [basisAt(...sideParameter(sides[0], t)), basisAt(...sideParameter(sides[1], 1 - t))] as const),
      guard: MEASURE_STATIONS.map((t) => [basisAt(...sideParameter(sides[0], t)), basisAt(...sideParameter(sides[1], 1 - t))] as const),
    };
    for (const face of seam.faces) if (star.has(face)) seamsOf.set(face, [...(seamsOf.get(face) ?? []), seam]);
  }
  const out: Vec3[][] = patches.map((patch) => patch.map((p): Vec3 => [p[0], p[1], p[2]]));
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const p of refined.vertices)
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k] as number, p[k] as number);
      high[k] = Math.max(high[k] as number, p[k] as number);
    }
  const extent = Math.max(Math.hypot(...high.map((h, k) => h - (low[k] as number))), 1e-300);
  const step = 1e-6 * extent;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (const f of [...star].sort((a, b) => a - b)) {
      const mine = seamsOf.get(f) ?? [];
      if (mine.length === 0) continue;
      // the neighbours' normals are fixed during this block
      const side = (seam: Seam): 0 | 1 => (seam.faces[0] === f ? 0 : 1);
      const fixed = mine.map((seam) =>
        seam.bases.map((pair) => normalAt(out[seam.faces[1 - side(seam)] as number] as Vec3[], pair[1 - side(seam)] as Basis)),
      );
      const fixedGuard = mine.map((seam) =>
        seam.guard.map((pair) => normalAt(out[seam.faces[1 - side(seam)] as number] as Vec3[], pair[1 - side(seam)] as Basis)),
      );
      const patch = out[f] as Vec3[];
      const guardAngle = (): number => {
        let worst = 0;
        mine.forEach((seam, si) =>
          seam.guard.forEach((pair, k) => {
            const cosine = dot3(normalAt(patch, pair[side(seam)] as Basis), (fixedGuard[si] as Vec3[])[k] as Vec3);
            worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, cosine))));
          }),
        );
        return worst;
      };
      const start = INTERIOR.flatMap(([i, j]) => [...((patches[f] as BezierPatch)[i * 4 + j] as Vec3)]);
      const apply = (x: ReadonlyArray<number>): void =>
        INTERIOR.forEach(([i, j], m) => (patch[i * 4 + j] = [x[m * 3] as number, x[m * 3 + 1] as number, x[m * 3 + 2] as number]));
      const rows = (): number[] => {
        const r: number[] = [];
        mine.forEach((seam, si) =>
          seam.bases.forEach((pair, k) => {
            const d = sub3(normalAt(patch, pair[side(seam)] as Basis), (fixed[si] as Vec3[])[k] as Vec3);
            r.push(d[0], d[1], d[2]);
          }),
        );
        return r;
      };
      const pullRows = (x: ReadonlyArray<number>): number[] => x.map((value, k) => (PULL * (value - (start[k] as number))) / extent);
      let x = INTERIOR.flatMap(([i, j]) => [...(patch[i * 4 + j] as Vec3)]);
      let r = [...rows(), ...pullRows(x)];
      let cost = r.reduce((sum, v) => sum + v * v, 0);
      let mu = 1e-3;
      let guard = guardAngle();
      for (let iteration = 0; iteration < BLOCK_ITERATIONS; iteration++) {
        const jacobian = r.map(() => new Array<number>(12).fill(0));
        for (let k = 0; k < 12; k++) {
          const moved = [...x];
          moved[k] = (moved[k] as number) + step;
          apply(moved);
          const shifted = rows();
          for (let row = 0; row < shifted.length; row++)
            (jacobian[row] as number[])[k] = ((shifted[row] as number) - (r[row] as number)) / step;
          (jacobian[shifted.length + k] as number[])[k] = PULL / extent;
        }
        apply(x);
        const normal = Array.from({ length: 12 }, (_, p) =>
          Array.from({ length: 12 }, (_, q) => jacobian.reduce((sum, row) => sum + (row[p] as number) * (row[q] as number), 0)),
        );
        const gradient = Array.from(
          { length: 12 },
          (_, p) => -jacobian.reduce((sum, row, i) => sum + (row[p] as number) * (r[i] as number), 0),
        );
        let accepted = false;
        for (let attempt = 0; attempt < 6 && !accepted; attempt++) {
          const damped = normal.map((row, p) => row.map((value, q) => (p === q ? value + mu * Math.max(value, 1e-12) : value)));
          const stepVector = solveDense(damped, [...gradient]);
          if (stepVector === null) {
            mu *= 10;
            continue;
          }
          const trial = x.map((value, k) => value + (stepVector[k] as number));
          apply(trial);
          const rt = [...rows(), ...pullRows(trial)];
          const trialCost = rt.reduce((sum, v) => sum + v * v, 0);
          const trialGuard = trialCost < cost ? guardAngle() : Infinity;
          if (trialCost < cost && trialGuard <= Math.max(1.25 * guard, FOLD_FLOOR)) {
            [x, r, cost, mu, guard, accepted] = [trial, rt, trialCost, Math.max(mu / 3, 1e-12), trialGuard, true];
          } else mu *= 10;
        }
        if (!accepted) break;
      }
      apply(x);
    }
  }
  return out;
}
