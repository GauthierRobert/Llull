/**
 * Soft-selection falloff (04 DIR §5.4): seven curves after Blender's proportional editing, and shortest-path distances over a weighted graph
 * ("connected only" metric). Pure; shared by every direct-editing command.
 */

export const FALLOFF_SHAPES = ['constant', 'linear', 'sharp', 'root', 'sphere', 'smooth', 'inverse_square'] as const;
export type FalloffShape = (typeof FALLOFF_SHAPES)[number];

/** f(t) for t = 1 - d/R in [0, 1] (t = 1 at the selection): constant 1, linear t, sharp t^2, root sqrt t, sphere sqrt(2t - t^2), smooth 3t^2 - 2t^3, inverse_square t(2 - t). */
export function falloffCurve(t: number, shape: FalloffShape): number {
  switch (shape) {
    case 'constant':
      return 1;
    case 'linear':
      return t;
    case 'sharp':
      return t * t;
    case 'root':
      return Math.sqrt(t);
    case 'sphere':
      return Math.sqrt(Math.max(0, 2 * t - t * t));
    case 'smooth':
      return Math.min(1, 3 * t * t - 2 * t * t * t);
    case 'inverse_square':
      return t * (2 - t);
  }
}

/** Selection weight at `distance` from the selection for a falloff `radius`: 1 inside (distance <= 1e-9), 0 beyond the radius, else the curve. */
export function softWeight(distance: number, radius: number, shape: FalloffShape): number {
  if (distance <= 1e-9) return 1;
  if (!(radius > 0) || distance >= radius) return 0;
  return falloffCurve(1 - distance / radius, shape);
}

/** An undirected weighted edge between graph nodes `a` and `b`. */
export interface WeightedEdge {
  readonly a: number;
  readonly b: number;
  readonly length: number;
}

/** Shortest path length from the nearest of `seeds` to every node (Infinity when unreachable); Dijkstra with a binary heap. */
export function graphDistances(nodeCount: number, edges: readonly WeightedEdge[], seeds: Iterable<number>): number[] {
  const neighbours: Array<Array<readonly [number, number]>> = Array.from({ length: nodeCount }, () => []);
  for (const { a, b, length } of edges) {
    neighbours[a]?.push([b, length]);
    neighbours[b]?.push([a, length]);
  }
  const distance = new Array<number>(nodeCount).fill(Infinity);
  const heap: Array<readonly [number, number]> = [];
  const push = (item: readonly [number, number]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heap[parent] as readonly [number, number])[0] <= (heap[i] as readonly [number, number])[0]) break;
      [heap[parent], heap[i]] = [heap[i] as readonly [number, number], heap[parent] as readonly [number, number]];
      i = parent;
    }
  };
  const pop = (): readonly [number, number] => {
    const top = heap[0] as readonly [number, number];
    const last = heap.pop() as readonly [number, number];
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let smallest = i;
        if (l < heap.length && (heap[l] as readonly [number, number])[0] < (heap[smallest] as readonly [number, number])[0]) smallest = l;
        if (r < heap.length && (heap[r] as readonly [number, number])[0] < (heap[smallest] as readonly [number, number])[0]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i] as readonly [number, number], heap[smallest] as readonly [number, number]];
        i = smallest;
      }
    }
    return top;
  };
  for (const seed of seeds) {
    distance[seed] = 0;
    push([0, seed]);
  }
  while (heap.length > 0) {
    const [d, node] = pop();
    if (d > (distance[node] as number)) continue;
    for (const [next, length] of neighbours[node] ?? []) {
      if (d + length < (distance[next] as number)) {
        distance[next] = d + length;
        push([d + length, next]);
      }
    }
  }
  return distance;
}
