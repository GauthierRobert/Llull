/**
 * Bridge of two boundary loops of a cage (04 DIR §5.3): a tube of quads joins loop A to loop B. A loop is the boundary of a face region that is
 * removed, or an existing hole of an open cage. The loops are paired by the rotation that minimises the summed distance (plus `twist`), B
 * traversed against A, and `segments` layers of quads are laid between them. Pure on its inputs: callers pass a working copy of the cage state.
 */

import type { Vec3 } from '../../model/types';
import { distance3, lerp3 } from '../../lib/vec3';
import type { CageState } from './cageState';
import { removeFaces } from './cageOps';
import { mintElementId } from './elements';
import { boundaryLoops } from './boundary';
import { type CageTopology, regionBoundary } from './topology';

/**
 * The single boundary loop of an edge-connected face region as a vertex sequence whose consecutive pairs are the directed edges the tube must
 * contain (the edges as wound in the removed faces), or why the region has no single loop.
 */
export function regionLoop(topology: CageTopology, region: readonly number[]): number[] | string {
  const boundary = regionBoundary(topology, new Set(region));
  if (boundary.length === 0) return 'the faces form a closed surface with no boundary';
  const next = new Map(boundary);
  const loop = [boundary[0]?.[0] as number];
  const seen = new Set(loop);
  for (let v = next.get(loop[0] as number); v !== undefined && !seen.has(v); v = next.get(v)) {
    loop.push(v);
    seen.add(v);
  }
  return loop.length === boundary.length
    ? loop
    : 'the faces have several boundary loops (a region with a hole, or two regions touching at a vertex)';
}

/** The hole of an open cage through the boundary edge a->b, as the vertex sequence the tube must follow (reverse of the face winding). */
export function holeLoop(topology: CageTopology, a: number, b: number): number[] | string {
  const loop = boundaryLoops(topology).find((candidate) =>
    candidate.some((v, i) => v === a && candidate[(i + 1) % candidate.length] === b),
  );
  return loop === undefined ? `edge ${a}-${b} is not on a boundary loop` : [...loop].reverse();
}

export interface BridgeResult {
  readonly vertices: number;
  readonly faces: number;
  /** Layer vertex ids from loop A (0) to loop B (segments); `ring[s][i]` pairs A_i with B_(offset - i). */
  readonly pairing: number;
}

/** The rotation o (B index of A_0 is `o`, then decreasing) that minimises the summed distance of the pairs A_i - B_(o - i). */
function bestRotation(positions: ReadonlyArray<Vec3>, a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let [best, bestSum] = [0, Infinity];
  for (let o = 0; o < n; o++) {
    let sum = 0;
    for (let i = 0; i < n; i++)
      sum += distance3(positions[a[i] as number] as Vec3, positions[b[(((o - i) % n) + n) % n] as number] as Vec3);
    if (sum < bestSum - 1e-12) [best, bestSum] = [o, sum];
  }
  return best;
}

/**
 * Joins loop `a` to loop `b` (equal lengths) with `segments` layers of quads, then removes `removed` faces (the regions the loops bounded) and the
 * vertices that leave unused. `twist` rotates the pairing by whole vertices. Mutates `state`.
 */
export function bridgeLoops(
  state: CageState,
  a: readonly number[],
  b: readonly number[],
  removed: ReadonlySet<number>,
  twist: number,
  segments: number,
): BridgeResult {
  const n = a.length;
  const taken = new Set([...state.vertexIds, ...state.faceIds]);
  const rotation = bestRotation(state.vertices, a, b) + twist;
  const partner = (i: number): number => b[(((rotation - i) % n) + n) % n] as number;
  const firstVertex = state.vertices.length;
  const firstFace = state.faces.length;
  const layers: number[][] = [[...a]];
  for (let s = 1; s < segments; s++)
    layers.push(
      a.map((v, i) => {
        state.vertices.push(lerp3(state.vertices[v] as Vec3, state.vertices[partner(i)] as Vec3, s / segments));
        state.vertexIds.push(mintElementId('v', taken));
        return state.vertices.length - 1;
      }),
    );
  layers.push(a.map((_, i) => partner(i)));
  for (let s = 0; s < segments; s++) {
    const [from, to] = [layers[s] as number[], layers[s + 1] as number[]];
    for (let i = 0; i < n; i++) {
      state.faces.push([from[i] as number, from[(i + 1) % n] as number, to[(i + 1) % n] as number, to[i] as number]);
      state.faceIds.push(mintElementId('f', taken));
    }
  }
  const created = { vertices: state.vertices.length - firstVertex, faces: state.faces.length - firstFace };
  removeFaces(state, removed);
  return { ...created, pairing: ((rotation % n) + n) % n };
}
