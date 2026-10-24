/**
 * Bevel of cage edges (04 DIR §5.3): every picked edge a-b with faces P (holding a->b) and Q (holding b->a) becomes a strip of `segments` quads. At
 * each end v the vertex splits into vP on the edge P leaves v by and vQ on the edge Q leaves v by, both `width` of that edge's length away; faces
 * between P and Q around v keep v and gain a triangle / polygon patch, a valence-3 end loses v. Picked edges must not share a vertex. Pure on
 * its inputs: callers pass a working copy of the cage state.
 */

import type { Vec3 } from '../../model/types';
import { lerp3 } from '../../lib/vec3';
import type { CageState } from './cageState';
import { compactState } from './cageOps';
import { edgeKey } from './edgeKey';
import { mintElementId } from './elements';
import type { CageTopology } from './topology';

export interface BevelProblem {
  readonly code: 'DIR_BEVEL_ADJACENT' | 'DIR_BEVEL_BOUNDARY';
  readonly message: string;
}

export const isBevelProblem = (value: BevelProblem | { vertices: number; faces: number }): value is BevelProblem => 'code' in value;

/** One corner edit: face `face`, corner index `corner` of the ORIGINAL face is replaced by `with` (in order). */
interface CornerEdit {
  readonly face: number;
  readonly corner: number;
  readonly with: number[];
}

/**
 * Bevels `edges` (distinct cage edges, none sharing a vertex) by `width` (fraction of the adjacent edge lengths, 0 < width < 0.5) into strips of
 * `segments` quads; the two long edges of each strip get `sharpness` (0 = smooth). Mutates `state`.
 * @failure an edge on the boundary, or two edges sharing a vertex -> BevelProblem
 */
export function bevelEdges(
  state: CageState,
  topology: CageTopology,
  edges: ReadonlyArray<readonly [number, number]>,
  width: number,
  segments: number,
  sharpness: number,
): BevelProblem | { vertices: number; faces: number } {
  const touched = new Set<number>();
  for (const [a, b] of edges) {
    if (!topology.directed.has(`${a}>${b}`) || !topology.directed.has(`${b}>${a}`))
      return { code: 'DIR_BEVEL_BOUNDARY', message: `edge ${a}-${b} borders only one face` };
    if (touched.has(a) || touched.has(b))
      return { code: 'DIR_BEVEL_ADJACENT', message: `edges sharing vertex ${touched.has(a) ? a : b} cannot be bevelled together` };
    touched.add(a).add(b);
  }
  const taken = new Set([...state.vertexIds, ...state.faceIds]);
  const original = state.vertices.map((p): Vec3 => [p[0], p[1], p[2]]);
  const firstVertex = state.vertices.length;
  const firstFace = state.faces.length;
  const sources = state.faces.map((face): number[] => [...face]);
  const edits: CornerEdit[] = [];
  const splits = new Map<string, Array<readonly [number, number]>>();
  const newFaces: number[][] = [];
  const addVertex = (p: Vec3): number => {
    state.vertices.push(p);
    state.vertexIds.push(mintElementId('v', taken));
    return state.vertices.length - 1;
  };
  const after = (face: readonly number[], v: number, steps: number): number =>
    face[(face.indexOf(v) + steps + face.length) % face.length] as number;

  /** Splits the end v of the edge v-w; returns the chain vP..vQ. */
  const endChain = (v: number, w: number): number[] => {
    const pFace = topology.directed.get(`${v}>${w}`) as number;
    const qFace = topology.directed.get(`${w}>${v}`) as number;
    const [p, q] = [sources[pFace] as number[], sources[qFace] as number[]];
    const [u, s] = [after(p, v, -1), after(q, v, 1)];
    const pos = (target: number): Vec3 => lerp3(original[v] as Vec3, original[target] as Vec3, width);
    const [vP, vQ] = [addVertex(pos(u)), addVertex(pos(s))];
    const chain = [vP];
    for (let k = 1; k < segments; k++) chain.push(addVertex(lerp3(state.vertices[vP] as Vec3, state.vertices[vQ] as Vec3, k / segments)));
    chain.push(vQ);
    const inP = topology.directed.get(`${v}>${u}`);
    const inQ = topology.directed.get(`${s}>${v}`);
    edits.push({ face: pFace, corner: p.indexOf(v), with: [vP] }, { face: qFace, corner: q.indexOf(v), with: [vQ] });
    splits.set(edgeKey(v, u), [
      [v, vP],
      [vP, u],
    ]);
    splits.set(edgeKey(v, s), [
      [v, vQ],
      [vQ, s],
    ]);
    if (inP !== undefined && inP === inQ) {
      const f = sources[inP] as number[];
      edits.push({ face: inP, corner: f.indexOf(v), with: [...chain].reverse() });
      splits.set(edgeKey(v, u), [[vP, u]]);
      splits.set(edgeKey(v, s), [[vQ, s]]);
    } else {
      if (inP !== undefined) edits.push({ face: inP, corner: (sources[inP] as number[]).indexOf(v), with: [v, vP] });
      if (inQ !== undefined) edits.push({ face: inQ, corner: (sources[inQ] as number[]).indexOf(v), with: [vQ, v] });
      if (inP !== undefined || inQ !== undefined) {
        newFaces.push([...chain].reverse().concat(v));
      }
    }
    return chain;
  };

  const longEdges: Array<readonly [number, number]> = [];
  for (const [a, b] of edges) {
    splits.set(edgeKey(a, b), []);
    const chainA = endChain(a, b);
    const chainB = endChain(b, a);
    // strips run F1 side -> F2 side: chainA = a1..a2 (P = F1 holds a->b), chainB = b2..b1
    const bFromF1 = [...chainB].reverse();
    for (let k = 0; k < segments; k++)
      newFaces.push([bFromF1[k] as number, chainA[k] as number, chainA[k + 1] as number, bFromF1[k + 1] as number]);
    longEdges.push([chainA[0] as number, bFromF1[0] as number], [chainA[segments] as number, bFromF1[segments] as number]);
  }
  state.faces.forEach((_, f) => {
    const mine = edits.filter((edit) => edit.face === f);
    if (mine.length === 0) return;
    state.faces[f] = (sources[f] as number[]).flatMap((v, i) => mine.find((edit) => edit.corner === i)?.with ?? [v]);
  });
  for (const face of newFaces) {
    state.faces.push(face);
    state.faceIds.push(mintElementId('f', taken));
  }
  const sharp: Array<readonly [number, number, number]> = [];
  for (const [a, b, s] of state.sharp) {
    const replacement = splits.get(edgeKey(a, b));
    if (replacement === undefined) sharp.push([a, b, s]);
    else for (const [x, y] of replacement) sharp.push([x, y, s]);
  }
  if (sharpness > 0) for (const [x, y] of longEdges) sharp.push([x, y, sharpness]);
  state.sharp.splice(0, state.sharp.length, ...sharp);
  const created = { vertices: state.vertices.length - firstVertex, faces: state.faces.length - firstFace };
  compactState(state);
  return created;
}
