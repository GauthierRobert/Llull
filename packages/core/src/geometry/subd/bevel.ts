/**
 * Bevel of cage edges (04 DIR §5.3, TECHNICAL_SPEC 5.3.1): every picked edge a-b with faces P (holding a->b) and Q (holding b->a) becomes a strip of `segments` quads.
 * A vertex with ONE picked edge splits into vP on the edge P leaves v by and vQ on the edge Q leaves v by (both `width` of that edge's length away); faces
 * between P and Q around v keep v and gain a triangle / polygon patch, a valence-3 end loses v. A vertex where TWO OR MORE picked edges meet (a chain, a corner)
 * is planned as a whole (`planCorner`): each face of its fan gets one corner point (a face between two picked edges: the parallelogram completion
 * v + width (w1 - v) + width (w2 - v); a face between a picked edge and another: the point `width` along the other edge, shared with the face on the other
 * side of it), the strips end on those points, and the polygon of the points around v is one patch face. Pure on its inputs: callers pass a working copy of the cage state.
 */

import type { Vec3 } from '../../model/types';
import { lerp3 } from '../../lib/vec3';
import type { CageState } from './cageState';
import { compactState } from './cageOps';
import { edgeKey } from './edgeKey';
import { mintElementId } from './elements';
import type { CageTopology } from './topology';

export interface BevelProblem {
  readonly code: 'DIR_BEVEL_BOUNDARY' | 'DIR_BEVEL_CORNER_UNSUPPORTED';
  readonly message: string;
}

export const isBevelProblem = (value: BevelProblem | { vertices: number; faces: number }): value is BevelProblem => 'code' in value;

/** Largest valence of a vertex where two or more picked edges meet (up to it the faces between edges that are not picked are always one run around the vertex). */
const MAX_CORNER_VALENCE = 4;

/** One corner edit: face `face`, corner index `corner` of the ORIGINAL face is replaced by `with` (in order). */
interface CornerEdit {
  readonly face: number;
  readonly corner: number;
  readonly with: number[];
}

/** What the bevel did to a non-picked edge a-b: a point inserted near an end, and whether that end vertex is gone. */
interface EdgeSplit {
  readonly a: number;
  readonly b: number;
  readonly near: Map<number, number>;
  readonly dropped: Set<number>;
}

/**
 * Bevels `edges` (distinct cage edges) by `width` (fraction of the adjacent edge lengths, 0 < width < 0.5) into strips of `segments` quads; the two long
 * edges of each strip get `sharpness` (0 = smooth). Mutates `state`.
 * @failure an edge on the boundary; a vertex of valence over 4 or on the boundary where two picked edges meet -> BevelProblem
 */
export function bevelEdges(
  state: CageState,
  topology: CageTopology,
  edges: ReadonlyArray<readonly [number, number]>,
  width: number,
  segments: number,
  sharpness: number,
): BevelProblem | { vertices: number; faces: number } {
  const picked = new Set<string>();
  const pickedAt = new Map<number, number>();
  for (const [a, b] of edges) {
    if (!topology.directed.has(`${a}>${b}`) || !topology.directed.has(`${b}>${a}`))
      return { code: 'DIR_BEVEL_BOUNDARY', message: `edge ${a}-${b} borders only one face` };
    picked.add(edgeKey(a, b));
    pickedAt.set(a, (pickedAt.get(a) ?? 0) + 1);
    pickedAt.set(b, (pickedAt.get(b) ?? 0) + 1);
  }
  const taken = new Set([...state.vertexIds, ...state.faceIds]);
  const original = state.vertices.map((p): Vec3 => [p[0], p[1], p[2]]);
  const firstVertex = state.vertices.length;
  const firstFace = state.faces.length;
  const sources = state.faces.map((face): number[] => [...face]);
  const edits: CornerEdit[] = [];
  const splitAt = new Map<string, EdgeSplit>();
  const newFaces: number[][] = [];
  const addVertex = (p: Vec3): number => {
    state.vertices.push(p);
    state.vertexIds.push(mintElementId('v', taken));
    return state.vertices.length - 1;
  };
  const after = (face: readonly number[], v: number, steps: number): number =>
    face[(face.indexOf(v) + steps + face.length) % face.length] as number;
  /** Records the point `p` inserted on the edge v-w near v (`dropped`: v itself leaves the cage). */
  const insertOn = (v: number, w: number, p: number, dropped: boolean): void => {
    const key = edgeKey(v, w);
    const split = splitAt.get(key) ?? { a: Math.min(v, w), b: Math.max(v, w), near: new Map<number, number>(), dropped: new Set<number>() };
    split.near.set(v, p);
    if (dropped) split.dropped.add(v);
    splitAt.set(key, split);
  };
  /** The `segments - 1` points between the vertices `from` and `to`. */
  const between = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let k = 1; k < segments; k++) out.push(addVertex(lerp3(state.vertices[from] as Vec3, state.vertices[to] as Vec3, k / segments)));
    return out;
  };

  /** Splits the end v of the edge v-w (the only picked edge at v); returns the chain vP..vQ. */
  const endChain = (v: number, w: number): number[] => {
    const pFace = topology.directed.get(`${v}>${w}`) as number;
    const qFace = topology.directed.get(`${w}>${v}`) as number;
    const [p, q] = [sources[pFace] as number[], sources[qFace] as number[]];
    const [u, s] = [after(p, v, -1), after(q, v, 1)];
    const pos = (target: number): Vec3 => lerp3(original[v] as Vec3, original[target] as Vec3, width);
    const [vP, vQ] = [addVertex(pos(u)), addVertex(pos(s))];
    const chain = [vP, ...between(vP, vQ), vQ];
    const inP = topology.directed.get(`${v}>${u}`);
    const inQ = topology.directed.get(`${s}>${v}`);
    edits.push({ face: pFace, corner: p.indexOf(v), with: [vP] }, { face: qFace, corner: q.indexOf(v), with: [vQ] });
    if (inP !== undefined && inP === inQ) {
      const f = sources[inP] as number[];
      edits.push({ face: inP, corner: f.indexOf(v), with: [...chain].reverse() });
      insertOn(v, u, vP, true);
      insertOn(v, s, vQ, true);
    } else {
      insertOn(v, u, vP, false);
      insertOn(v, s, vQ, false);
      if (inP !== undefined) edits.push({ face: inP, corner: (sources[inP] as number[]).indexOf(v), with: [v, vP] });
      if (inQ !== undefined) edits.push({ face: inQ, corner: (sources[inQ] as number[]).indexOf(v), with: [vQ, v] });
      if (inP !== undefined || inQ !== undefined) newFaces.push([...chain].reverse().concat(v));
    }
    return chain;
  };

  /** The fan of faces around the interior vertex v in winding order: face i holds w_i -> v -> w_{i+1}; null when it does not close. */
  const fanOf = (v: number): { faces: number[]; ring: number[] } | null => {
    const around = topology.vertexFaces[v] as number[];
    const first = around[0] as number;
    const faces: number[] = [];
    const ring: number[] = [];
    let f = first;
    do {
      faces.push(f);
      ring.push(after(sources[f] as number[], v, -1));
      const next = topology.directed.get(`${after(sources[f] as number[], v, 1)}>${v}`);
      if (next === undefined || faces.length > around.length) return null;
      f = next;
    } while (f !== first);
    return faces.length === around.length ? { faces, ring } : null;
  };

  /** Chains of the picked edges at a planned corner v, by the other end w: from the side of the face holding v->w to the side of the face holding w->v. */
  const cornerChains = new Map<number, Map<number, number[]>>();

  const planCorner = (v: number): BevelProblem | null => {
    const fan = fanOf(v);
    const valence = (topology.vertexFaces[v] as number[]).length;
    if (fan === null)
      return {
        code: 'DIR_BEVEL_CORNER_UNSUPPORTED',
        message: `vertex ${v} is on the boundary or not a manifold vertex: a chain of bevelled edges cannot cross it`,
      };
    if (valence > MAX_CORNER_VALENCE)
      return {
        code: 'DIR_BEVEL_CORNER_UNSUPPORTED',
        message: `${pickedAt.get(v)} bevelled edges meet at vertex ${v} of valence ${valence} (corners up to valence ${MAX_CORNER_VALENCE} are supported)`,
      };
    const { faces, ring } = fan;
    const n = faces.length;
    const bev = ring.map((w) => picked.has(edgeKey(v, w)));
    const pointOnEdge = new Map<number, number>();
    const onEdge = (j: number): number => {
      let p = pointOnEdge.get(j);
      if (p === undefined) {
        p = addVertex(lerp3(original[v] as Vec3, original[ring[j] as number] as Vec3, width));
        pointOnEdge.set(j, p);
      }
      return p;
    };
    const o = original[v] as Vec3;
    // what the corner v of fan face i becomes (null: the face lies between two edges that are not picked and keeps v)
    const replacement: Array<number[] | null> = faces.map((_, i) => {
      const [incoming, outgoing] = [bev[i] as boolean, bev[(i + 1) % n] as boolean];
      if (incoming && outgoing) {
        const [p, q] = [original[ring[i] as number] as Vec3, original[ring[(i + 1) % n] as number] as Vec3];
        return [
          addVertex([
            o[0] + width * (p[0] - o[0]) + width * (q[0] - o[0]),
            o[1] + width * (p[1] - o[1]) + width * (q[1] - o[1]),
            o[2] + width * (p[2] - o[2]) + width * (q[2] - o[2]),
          ]),
        ];
      }
      if (incoming) return [onEdge((i + 1) % n)];
      if (outgoing) return [onEdge(i)];
      return null;
    });
    const plain = replacement.flatMap((r, i) => (r === null ? [i] : []));
    const chains = new Map<number, number[]>();
    cornerChains.set(v, chains);
    const loop: number[] = [];
    const push = (p: number): void => {
      if (loop[loop.length - 1] !== p) loop.push(p);
    };
    faces.forEach((_, i) => {
      for (const p of replacement[i] ?? [v]) push(p);
      const next = (i + 1) % n;
      if (bev[next]) {
        const [from, to] = [(replacement[i] as number[]).at(-1) as number, (replacement[next] as number[])[0] as number];
        const mid = between(from, to);
        chains.set(ring[next] as number, [from, ...mid, to]);
        for (const p of mid) push(p);
      }
    });
    if (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    const keep = plain.length >= 2;
    const patch = [...loop].reverse();
    faces.forEach((f, i) => {
      const r = replacement[i];
      const corner = (sources[f] as number[]).indexOf(v);
      if (r !== null) {
        edits.push({ face: f, corner, with: r as number[] });
        return;
      }
      if (keep) {
        const [x0, x1] = [pointOnEdge.get(i), pointOnEdge.get((i + 1) % n)];
        edits.push({ face: f, corner, with: [...(x0 === undefined ? [] : [x0]), v, ...(x1 === undefined ? [] : [x1])] });
      } else {
        // the only face between edges that are not picked takes the whole patch in place of v
        const at = patch.indexOf(v);
        edits.push({ face: f, corner, with: [...patch.slice(at + 1), ...patch.slice(0, at)] });
      }
    });
    if (plain.length !== 1 && patch.length >= 3) newFaces.push(patch);
    for (const [j, p] of pointOnEdge) insertOn(v, ring[j] as number, p, !keep);
    return null;
  };

  for (const [v, count] of pickedAt) {
    if (count < 2) continue;
    const problem = planCorner(v);
    if (problem !== null) return problem;
  }
  const chainOf = (v: number, w: number): number[] => cornerChains.get(v)?.get(w) ?? endChain(v, w);

  const longEdges: Array<readonly [number, number]> = [];
  for (const [a, b] of edges) {
    const chainA = chainOf(a, b);
    const chainB = chainOf(b, a);
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
    const key = edgeKey(a, b);
    if (picked.has(key)) continue;
    const split = splitAt.get(key);
    if (split === undefined) {
      sharp.push([a, b, s]);
      continue;
    }
    // the edge a-b is cut at the points near its ends (an end that left the cage is no node); the pieces keep its sharpness
    const nodes = [
      ...(split.dropped.has(split.a) ? [] : [split.a]),
      ...(split.near.has(split.a) ? [split.near.get(split.a) as number] : []),
      ...(split.near.has(split.b) ? [split.near.get(split.b) as number] : []),
      ...(split.dropped.has(split.b) ? [] : [split.b]),
    ];
    for (let k = 0; k + 1 < nodes.length; k++) sharp.push([nodes[k] as number, nodes[k + 1] as number, s]);
  }
  if (sharpness > 0) for (const [x, y] of longEdges) sharp.push([x, y, sharpness]);
  state.sharp.splice(0, state.sharp.length, ...sharp);
  const created = { vertices: state.vertices.length - firstVertex, faces: state.faces.length - firstFace };
  compactState(state);
  return created;
}
