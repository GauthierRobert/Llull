/**
 * Boundary patches: a Coons surface bounded by four curves (or ruled between two), sampled on a grid and thickened into a closed
 * subdivision cage (top sheet on the curves' side, an offset sheet behind it, side walls). The rim and the four patch corners are creased
 * so the smooth surface keeps the boundary. Pure; used by surface_from_curves.
 */

import type { Vec3 } from '../model/types';
import { add3, distance3, lerp3, normalize3, scale3, sub3, cross3, len3 } from '../lib/vec3';
import { segmentLengths } from '../lib/polyline';
import type { Cage } from './subdivision';
import { clamp, clamp01 } from '../lib/clamp';

/** Point at arc-length fraction `t` in [0, 1] along a polyline (>= 2 points). */
export function polylineAt(points: readonly Vec3[], t: number): Vec3 {
  const lengths = segmentLengths(points);
  const total = lengths.reduce((sum, l) => sum + l, 0);
  let target = clamp01(t) * total;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i] as number;
    if (target <= length || i === lengths.length - 1) {
      const f = length > 0 ? Math.min(target / length, 1) : 0;
      return lerp3(points[i] as Vec3, points[i + 1] as Vec3, f);
    }
    target -= length;
  }
  return points[points.length - 1] as Vec3;
}

const first = (curve: readonly Vec3[]): Vec3 => curve[0] as Vec3;
const last = (curve: readonly Vec3[]): Vec3 => curve[curve.length - 1] as Vec3;

/**
 * The four sides as functions of a parameter in [0, 1]: bottom P00→P10, right P10→P11, top P01→P11, left P00→P01. Four curves must chain
 * end to start (any order / direction) within `tolerance`; two curves are opposite sides joined by straight lines. Error text otherwise.
 */
export function coonsSides(curves: readonly (readonly Vec3[])[], tolerance: number): Array<(t: number) => Vec3> | string {
  if (curves.some((curve) => curve.length < 2)) return 'every curve needs at least 2 points';
  const at = (curve: readonly Vec3[]) => (t: number) => polylineAt(curve, t);
  if (curves.length === 2) {
    const [bottom, raw] = curves as [readonly Vec3[], readonly Vec3[]];
    const keep =
      distance3(first(bottom), first(raw)) + distance3(last(bottom), last(raw)) <=
      distance3(first(bottom), last(raw)) + distance3(last(bottom), first(raw));
    const top = keep ? raw : [...raw].reverse();
    if (distance3(first(bottom), first(top)) <= tolerance)
      return 'the two curves touch at their start; give curves facing each other across the patch';
    return [
      at(bottom),
      (t) => add3(last(bottom), scale3(sub3(last(top), last(bottom)), t)),
      at(top),
      (t) => add3(first(bottom), scale3(sub3(first(top), first(bottom)), t)),
    ];
  }
  if (curves.length !== 4) return `give 2 or 4 curves (got ${curves.length})`;
  const chain: Array<readonly Vec3[]> = [curves[0] as readonly Vec3[]];
  const remaining = curves.slice(1);
  while (remaining.length > 0) {
    const end = last(chain[chain.length - 1] as readonly Vec3[]);
    let best = -1;
    let reversed = false;
    let gap = Infinity;
    remaining.forEach((curve, k) => {
      for (const [d, flip] of [
        [distance3(end, first(curve)), false],
        [distance3(end, last(curve)), true],
      ] as const) {
        if (d < gap) [gap, best, reversed] = [d, k, flip];
      }
    });
    if (gap > tolerance) return `the curves do not form a closed loop (a ${gap.toPrecision(3)} gap after curve ${chain.length - 1})`;
    const next = remaining.splice(best, 1)[0] as readonly Vec3[];
    chain.push(reversed ? [...next].reverse() : next);
  }
  const closing = distance3(last(chain[3] as readonly Vec3[]), first(chain[0] as readonly Vec3[]));
  if (closing > tolerance) return `the curves do not form a closed loop (a ${closing.toPrecision(3)} gap closing it)`;
  const [bottom, right, top, left] = chain as [Vec3[], Vec3[], Vec3[], Vec3[]];
  return [at(bottom), at(right), at([...top].reverse()), at([...left].reverse())];
}

/** Coons surface point of the four sides at (u, v). */
function coonsPoint(sides: ReadonlyArray<(t: number) => Vec3>, u: number, v: number): Vec3 {
  const [bottom, right, top, left] = sides as [(t: number) => Vec3, (t: number) => Vec3, (t: number) => Vec3, (t: number) => Vec3];
  const [p00, p10, p01, p11] = [bottom(0), bottom(1), top(0), top(1)];
  const ruled = add3(add3(scale3(bottom(u), 1 - v), scale3(top(u), v)), add3(scale3(left(v), 1 - u), scale3(right(v), u)));
  const bilinear = add3(add3(scale3(p00, (1 - u) * (1 - v)), scale3(p10, u * (1 - v))), add3(scale3(p01, (1 - u) * v), scale3(p11, u * v)));
  return sub3(ruled, bilinear);
}

/**
 * Closed cage of the patch thickened by `thickness` behind its u × v normal (`flip` thickens in
 * front instead), `nu` × `nv` cells, rim and corners creased; or an error message.
 */
export function boundaryPatchCage(
  sides: ReadonlyArray<(t: number) => Vec3>,
  nu: number,
  nv: number,
  thickness: number,
  flip: boolean,
): Cage | string {
  const grid: Vec3[][] = [];
  for (let i = 0; i <= nu; i++) {
    grid.push([]);
    for (let j = 0; j <= nv; j++) grid[i]?.push(coonsPoint(sides, i / nu, j / nv));
  }
  const g = (i: number, j: number): Vec3 => grid[clamp(i, 0, nu)]?.[clamp(j, 0, nv)] as Vec3;
  const offsets: Vec3[][] = [];
  for (let i = 0; i <= nu; i++) {
    offsets.push([]);
    for (let j = 0; j <= nv; j++) {
      const normal = cross3(sub3(g(i + 1, j), g(i - 1, j)), sub3(g(i, j + 1), g(i, j - 1)));
      if (len3(normal) < 1e-12) return `the patch is degenerate near cell (${i}, ${j})`;
      const away = scale3(normalize3(normal), flip ? thickness : -thickness);
      offsets[i]?.push(add3(g(i, j), away));
    }
  }
  const [frontSheet, backSheet] = flip ? [offsets, grid] : [grid, offsets];
  const count = (nu + 1) * (nv + 1);
  const front = (i: number, j: number): number => i * (nv + 1) + j;
  const back = (i: number, j: number): number => count + front(i, j);
  const vertices = [...frontSheet.flat(), ...backSheet.flat()];
  const faces: number[][] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      faces.push([front(i, j), front(i + 1, j), front(i + 1, j + 1), front(i, j + 1)]);
      faces.push([back(i, j + 1), back(i + 1, j + 1), back(i + 1, j), back(i, j)]);
    }
  }
  const rim: Array<[number, number]> = [
    ...Array.from({ length: nu }, (_, i): [number, number] => [i, 0]),
    ...Array.from({ length: nv }, (_, j): [number, number] => [nu, j]),
    ...Array.from({ length: nu }, (_, i): [number, number] => [nu - i, nv]),
    ...Array.from({ length: nv }, (_, j): [number, number] => [0, nv - j]),
  ];
  const creases: Array<[number, number]> = [];
  rim.forEach(([i, j], k) => {
    const [ni, nj] = rim[(k + 1) % rim.length] as [number, number];
    faces.push([front(ni, nj), front(i, j), back(i, j), back(ni, nj)]);
    creases.push([front(i, j), front(ni, nj)], [back(i, j), back(ni, nj)]);
  });
  for (const [i, j] of [
    [0, 0],
    [nu, 0],
    [nu, nv],
    [0, nv],
  ] as const)
    creases.push([front(i, j), back(i, j)]);
  return { vertices, faces, creases };
}
