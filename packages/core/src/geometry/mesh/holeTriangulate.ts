/**
 * Triangulation of a boundary loop (Liepa 2003, stage 2): O(n^3) dynamic programming over the loop with the lexicographic weight
 * (largest dihedral angle to the neighbouring faces, then total area) after Barequet and Sharir; loops above `DP_LOOP_LIMIT` edges use a
 * greedy ear clip (smallest corner angle first). Patch triangles are returned already oriented against the boundary edge direction.
 * @invariant a diagonal never duplicates an existing mesh edge; zero-area triangles are never produced
 */

import type { Vec3 } from '../../model/vectors';
import { normalOf } from './editMesh';

/** Largest loop (edges) triangulated by the O(n^3) program. */
const DP_LOOP_LIMIT = 120;

export interface LoopGeometry {
  readonly position: (vertex: number) => Vec3;
  /** Unit normal of the mesh face across loop edge i (v_i -> v_i+1), or null. */
  readonly outsideNormal: (edge: number) => Vec3 | null;
  readonly edgeExists: (a: number, b: number) => boolean;
}

export interface LoopTriangulation {
  readonly triangles: Array<[number, number, number]>;
  readonly method: 'dp' | 'greedy';
}

const unitOrNull = (n: Vec3): Vec3 | null => {
  const length = Math.hypot(...n);
  return length > 1e-300 ? [n[0] / length, n[1] / length, n[2] / length] : null;
};

const angleBetween = (a: Vec3, b: Vec3): number => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

const ANGLE_TIE = 1e-9;

function dynamicProgram(loop: ReadonlyArray<number>, geometry: LoopGeometry): LoopTriangulation | null {
  const n = loop.length;
  const point = loop.map(geometry.position);
  const outside = loop.map((_, i) => geometry.outsideNormal(i));
  const worst = new Float64Array(n * n);
  const area = new Float64Array(n * n);
  const apex = new Int32Array(n * n).fill(-1);
  const feasible = new Uint8Array(n * n);
  for (let i = 0; i + 1 < n; i++) feasible[i * n + i + 1] = 1;
  const normalOfTriangle = (i: number, m: number, k: number): Vec3 | null =>
    unitOrNull(normalOf(point[k] as Vec3, point[m] as Vec3, point[i] as Vec3));
  const neighbourNormal = (a: number, b: number): Vec3 | null => {
    if (b === a + 1) return outside[a] ?? null;
    return normalOfTriangle(a, apex[a * n + b] as number, b);
  };
  for (let length = 2; length < n; length++) {
    for (let i = 0; i + length < n; i++) {
      const k = i + length;
      if (!(k - i === n - 1) && geometry.edgeExists(loop[i] as number, loop[k] as number)) continue;
      let best = -1;
      let bestAngle = Infinity;
      let bestArea = Infinity;
      for (let m = i + 1; m < k; m++) {
        if (feasible[i * n + m] !== 1 || feasible[m * n + k] !== 1) continue;
        const normal = normalOfTriangle(i, m, k);
        if (normal === null) continue;
        let angle = Math.max(worst[i * n + m] as number, worst[m * n + k] as number);
        for (const neighbour of [neighbourNormal(i, m), neighbourNormal(m, k), k - i === n - 1 ? (outside[n - 1] ?? null) : null]) {
          if (neighbour !== null) angle = Math.max(angle, angleBetween(normal, neighbour));
        }
        const total =
          (area[i * n + m] as number) +
          (area[m * n + k] as number) +
          Math.hypot(...normalOf(point[k] as Vec3, point[m] as Vec3, point[i] as Vec3)) / 2;
        if (angle < bestAngle - ANGLE_TIE || (angle <= bestAngle + ANGLE_TIE && total < bestArea)) {
          best = m;
          bestAngle = angle;
          bestArea = total;
        }
      }
      if (best < 0) continue;
      feasible[i * n + k] = 1;
      apex[i * n + k] = best;
      worst[i * n + k] = bestAngle;
      area[i * n + k] = bestArea;
    }
  }
  if (feasible[n - 1] !== 1) return null;
  const triangles: Array<[number, number, number]> = [];
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [i, k] = stack.pop() as [number, number];
    if (k - i < 2) continue;
    const m = apex[i * n + k] as number;
    triangles.push([loop[k] as number, loop[m] as number, loop[i] as number]);
    stack.push([m, k], [i, m]);
  }
  return { triangles, method: 'dp' };
}

function greedyEars(loop: ReadonlyArray<number>, geometry: LoopGeometry): LoopTriangulation | null {
  const ring = [...loop];
  const triangles: Array<[number, number, number]> = [];
  const cornerAngle = (a: number, b: number, c: number): number => {
    const [pa, pb, pc] = [geometry.position(a), geometry.position(b), geometry.position(c)];
    const u: Vec3 = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]];
    const v: Vec3 = [pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]];
    const lu = Math.hypot(...u);
    const lv = Math.hypot(...v);
    return lu * lv > 0 ? angleBetween([u[0] / lu, u[1] / lu, u[2] / lu], [v[0] / lv, v[1] / lv, v[2] / lv]) : Math.PI;
  };
  while (ring.length > 3) {
    let best = -1;
    let bestAngle = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const [a, b, c] = [ring[(i + ring.length - 1) % ring.length], ring[i], ring[(i + 1) % ring.length]] as [number, number, number];
      if (geometry.edgeExists(a, c)) continue;
      const normal = normalOf(geometry.position(c), geometry.position(b), geometry.position(a));
      if (Math.hypot(...normal) < 1e-300) continue;
      const angle = cornerAngle(a, b, c);
      if (angle < bestAngle) {
        bestAngle = angle;
        best = i;
      }
    }
    if (best < 0) return null;
    const [a, b, c] = [ring[(best + ring.length - 1) % ring.length], ring[best], ring[(best + 1) % ring.length]] as [
      number,
      number,
      number,
    ];
    triangles.push([c, b, a]);
    ring.splice(best, 1);
  }
  const [a, b, c] = ring as [number, number, number];
  if (Math.hypot(...normalOf(geometry.position(c), geometry.position(b), geometry.position(a))) < 1e-300) return null;
  triangles.push([c, b, a]);
  return { triangles, method: 'greedy' };
}

/** Triangulate `loop` (vertices in boundary-edge direction, at least 3); null when no valid triangulation exists. */
export function triangulateLoop(loop: ReadonlyArray<number>, geometry: LoopGeometry): LoopTriangulation | null {
  if (loop.length < 3) return null;
  return loop.length <= DP_LOOP_LIMIT ? dynamicProgram(loop, geometry) : greedyEars(loop, geometry);
}
