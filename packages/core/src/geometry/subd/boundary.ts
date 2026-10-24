/** Boundary of an open cage (04 DIR §5.3): the directed edges with no twin and the closed loops they form. Pure. */

import type { CageTopology } from './topology';

/** Directed boundary edges a->b (as wound in their face) in face order. */
function boundaryEdges(topology: CageTopology): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const face of topology.faces)
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      if (!topology.directed.has(`${b}>${a}`)) out.push([a, b]);
    });
  return out;
}

/** True when some edge borders a single face. */
export const isOpenCage = (topology: CageTopology): boolean => boundaryEdges(topology).length > 0;

/**
 * Boundary loops as vertex sequences v0, v1, ... following the face winding (each consecutive pair is a boundary edge as wound in its face; the
 * last returns to the first). A vertex where several loops touch ends a loop early: the loop is then reported as it closes.
 */
export function boundaryLoops(topology: CageTopology): number[][] {
  const next = new Map<number, number>();
  for (const [a, b] of boundaryEdges(topology)) if (!next.has(a)) next.set(a, b);
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of [...next.keys()].sort((x, y) => x - y)) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    loops.push(loop);
  }
  return loops;
}
