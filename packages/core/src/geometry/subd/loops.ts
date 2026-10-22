/**
 * Edge loops, quad rings and loop cuts of a quad cage (04 DIR §5.3). A ring is the strip of quads crossed by an edge: edge j runs
 * s_j -> t_j and the strip face F_j holds that directed edge, so all strip faces keep the winding of the cage. Pure on its inputs.
 */

import type { Vec3 } from '../../model/types';
import { lerp3 } from '../../lib/vec3';
import type { CageState } from './cageState';
import { edgeKey } from './edgeKey';
import { mintElementId } from './elements';
import { type CageTopology, neighbourVertices } from './topology';

export interface Ring {
  /** Crossed edges, oriented so that consecutive strip quads are [s_j, t_j, t_(j+1), s_(j+1)]. */
  readonly edges: Array<readonly [number, number]>;
  /** `faces[j]` holds the directed edge `edges[j]`. */
  readonly faces: number[];
}

export interface RingProblem {
  readonly face: number;
  readonly message: string;
}

/** The quad strip crossed by edge a-b (directed as a->b on its first face), or why it stops: a non-quad face, a boundary, a twisted strip. */
export function walkRing(topology: CageTopology, a: number, b: number): Ring | RingProblem {
  const edges: Array<readonly [number, number]> = [];
  const faces: number[] = [];
  let [s, t] = [a, b];
  do {
    const f = topology.directed.get(`${s}>${t}`);
    if (f === undefined) return { face: -1, message: `edge ${s}-${t} borders no face on one side` };
    const face = topology.faces[f] as ReadonlyArray<number>;
    if (face.length !== 4) return { face: f, message: `face ${f} has ${face.length} sides; the strip needs quads` };
    edges.push([s, t]);
    faces.push(f);
    const i = face.indexOf(s);
    [s, t] = [face[(i + 3) % 4] as number, face[(i + 2) % 4] as number];
  } while (!(s === a && t === b) && faces.length <= topology.faces.length);
  return { edges, faces };
}

export const isRingProblem = (value: Ring | RingProblem): value is RingProblem => 'message' in value;

/** Next vertex straight through `at` when arriving from `from` (valence-4 vertices only), else null. */
function straightThrough(topology: CageTopology, from: number, at: number): number | null {
  const around = neighbourVertices(topology, at);
  if (around.length !== 4) return null;
  const sides = new Set<number>([from]);
  for (const face of (topology.vertexFaces[at] as number[]).map((f) => topology.faces[f] as ReadonlyArray<number>)) {
    if (face.includes(from)) face.forEach((v) => sides.add(v));
  }
  return around.find((v) => !sides.has(v)) as number;
}

/** Edge loop through a-b: the chain continued straight through valence-4 vertices in both directions (ordered; closed loops end next to the start). */
export function edgeLoop(topology: CageTopology, a: number, b: number): Array<readonly [number, number]> {
  const forward: Array<readonly [number, number]> = [[a, b]];
  const extend = (from: number, at: number, out: Array<readonly [number, number]>): boolean => {
    let [previous, current] = [from, at];
    while (out.length <= topology.edges.length) {
      const next = straightThrough(topology, previous, current);
      if (next === null) return false;
      if (edgeKey(current, next) === edgeKey(a, b)) return true;
      out.push([current, next]);
      [previous, current] = [current, next];
    }
    return true;
  };
  const closed = extend(a, b, forward);
  if (closed) return forward;
  const backward: Array<readonly [number, number]> = [];
  extend(b, a, backward);
  return [...backward.reverse().map(([x, y]): readonly [number, number] => [y, x]), ...forward];
}

/** Cuts `cuts` new vertices into every crossed edge at `fractions` (from s_j) and splits each strip quad; mutates the working copy `state`. */
export function cutRing(state: CageState, ring: Ring, fractions: readonly number[]): { vertices: number; faces: number } {
  const taken = new Set([...state.vertexIds, ...state.faceIds]);
  const firstVertex = state.vertices.length;
  const firstFace = state.faces.length;
  const rows = ring.edges.map(([s, t]) => {
    const row = [s];
    for (const f of fractions) {
      row.push(state.vertices.length);
      state.vertices.push(lerp3(state.vertices[s] as Vec3, state.vertices[t] as Vec3, f));
      state.vertexIds.push(mintElementId('v', taken));
    }
    row.push(t);
    return row;
  });
  const owner = new Map(ring.edges.map(([s, t], j) => [edgeKey(s, t), j]));
  const split: Array<readonly [number, number, number]> = [];
  for (const [a, b, sharpness] of state.sharp) {
    const j = owner.get(edgeKey(a, b));
    if (j === undefined) {
      split.push([a, b, sharpness]);
      continue;
    }
    const row = rows[j] as number[];
    for (let i = 0; i + 1 < row.length; i++) split.push([row[i] as number, row[i + 1] as number, sharpness]);
  }
  state.sharp.splice(0, state.sharp.length, ...split);
  const extra: number[][] = [];
  ring.faces.forEach((f, j) => {
    const [row, next] = [rows[j] as number[], rows[(j + 1) % rows.length] as number[]];
    for (let i = 0; i <= fractions.length; i++) {
      const quad = [row[i] as number, row[i + 1] as number, next[i + 1] as number, next[i] as number];
      if (i === 0) state.faces[f] = quad;
      else extra.push(quad);
    }
  });
  for (const quad of extra) {
    state.faces.push(quad);
    state.faceIds.push(mintElementId('f', taken));
  }
  return { vertices: state.vertices.length - firstVertex, faces: state.faces.length - firstFace };
}
