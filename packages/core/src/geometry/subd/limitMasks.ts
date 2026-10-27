/**
 * Limit-point masks of an all-quad Catmull-Clark level (Halstead et al. 1993 for smooth vertices, the exact eigenvector mask of `dartMask` for a vertex with one sharp edge, (4v + a + b) / 6 on creases, v at corners):
 * for each vertex the cage vertices that make its limit position and their weights. Pure.
 */

import type { RefinableCage } from '../subdivision';
import { dartMask } from './dartMask';
import { edgeKey } from './edgeKey';
import { fanOf, prepareSharpness } from './limit';
import { vertexRule } from './sharpness';
import { neighbourVertices } from './topology';

export interface Mask {
  readonly idx: number[];
  readonly w: number[];
}

/** Masks of the limit points of every vertex of `level` (all faces quads). */
export function limitMasks(level: RefinableCage<unknown>): Mask[] {
  const prepared = prepareSharpness(level);
  const { topology, sharp, corners } = prepared;
  return level.vertices.map((_, v): Mask => {
    const sharpNeighbours = neighbourVertices(topology, v).filter((w) => (sharp.get(edgeKey(v, w)) ?? 0) > 0);
    const rule = vertexRule(sharpNeighbours.length, corners[v] as number);
    if (rule === 'corner') return { idx: [v], w: [1] };
    if (rule === 'crease') return { idx: [v, ...(sharpNeighbours as [number, number])], w: [4 / 6, 1 / 6, 1 / 6] };
    const { e, d } = fanOf(prepared, v);
    const n = e.length;
    const sharpIndex = sharpNeighbours.length === 1 ? e.indexOf(sharpNeighbours[0] as number) : -1;
    if (sharpIndex >= 0) return { idx: [v, ...e, ...d], w: dartMask(n, sharpIndex) };
    const norm = n * (n + 5);
    return { idx: [v, ...e, ...d], w: [(n * n) / norm, ...e.map(() => 4 / norm), ...d.map(() => 1 / norm)] };
  });
}
