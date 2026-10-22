/**
 * Crease sharpness bookkeeping of Catmull-Clark refinement (OpenSubdiv semi-sharp creases, 04 DIR §5.1). Sharpness is 0 (smooth) .. 10
 * (infinitely sharp); one refinement step lowers a finite sharpness by 1 (Uniform) or by the Chaikin average. Pure.
 */

import { edgeKey } from './edgeKey';

/** Sharpness at and above which an edge or vertex stays sharp at every level. */
export const SHARP_MAX = 10;

export type CreaseMethod = 'uniform' | 'chaikin';
export type VertexRule = 'smooth' | 'crease' | 'corner';

/** Sharpness fields of a cage (`creases` = infinitely sharp edges). */
export interface SharpnessSource {
  readonly creases: ReadonlyArray<readonly [number, number]>;
  readonly edgeSharpness?: ReadonlyArray<{ readonly a: number; readonly b: number; readonly s: number }> | undefined;
  readonly vertexSharpness?: ReadonlyArray<{ readonly v: number; readonly s: number }> | undefined;
}

/** Sharpness by edge key (`creases` count as SHARP_MAX; the larger value wins). */
export function edgeSharpnessMap(cage: SharpnessSource): Map<string, number> {
  const map = new Map<string, number>();
  for (const { a, b, s } of cage.edgeSharpness ?? []) map.set(edgeKey(a, b), Math.min(SHARP_MAX, Math.max(map.get(edgeKey(a, b)) ?? 0, s)));
  for (const [a, b] of cage.creases) map.set(edgeKey(a, b), SHARP_MAX);
  return map;
}

/** Corner sharpness per vertex (0 where none). */
export function vertexSharpnessArray(cage: SharpnessSource, count: number): number[] {
  const out = new Array<number>(count).fill(0);
  for (const { v, s } of cage.vertexSharpness ?? []) if (v >= 0 && v < count) out[v] = Math.min(SHARP_MAX, Math.max(out[v] as number, s));
  return out;
}

/** Uniform child sharpness: infinite stays, s > 1 loses 1, s <= 1 becomes smooth. */
export function uniformChild(s: number): number {
  if (s >= SHARP_MAX) return SHARP_MAX;
  return s > 1 ? s - 1 : 0;
}

/**
 * Sharpness of the child edge at an end vertex of an edge with sharpness `s` (OpenSubdiv `crease.cpp`): Uniform lowers by 1; Chaikin
 * averages 3/4 of `s` with 1/4 of the mean of the `others` (the other sharp edges at that vertex), minus 1.
 */
export function childEdgeSharpness(s: number, method: CreaseMethod, others: readonly number[]): number {
  if (s >= SHARP_MAX) return SHARP_MAX;
  if (method === 'uniform' || others.length === 0) return uniformChild(s);
  const mean = others.reduce((total, value) => total + value, 0) / others.length;
  return Math.max(0, 0.75 * s + 0.25 * mean - 1);
}

/** Vertex rule from the number of sharp edges (> 0) at the vertex and its corner sharpness. */
export function vertexRule(sharpEdgeCount: number, vertexSharpness: number): VertexRule {
  if (vertexSharpness > 0 || sharpEdgeCount > 2) return 'corner';
  return sharpEdgeCount === 2 ? 'crease' : 'smooth';
}

/** Split sharpness entries into the entity representation: infinite edges in `creases`, finite 0 < s < 10 in `edgeSharpness`. */
export function partitionSharpness(entries: Iterable<readonly [number, number, number]>): {
  creases: Array<[number, number]>;
  edgeSharpness: Array<{ a: number; b: number; s: number }>;
} {
  const creases: Array<[number, number]> = [];
  const edgeSharpness: Array<{ a: number; b: number; s: number }> = [];
  for (const [a, b, s] of entries) {
    if (s >= SHARP_MAX) creases.push([a, b]);
    else if (s > 0) edgeSharpness.push({ a, b, s });
  }
  return { creases, edgeSharpness };
}
