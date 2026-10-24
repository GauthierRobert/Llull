/**
 * Simple topology operations of a cage (04 DIR §5.3): delete faces, fill a boundary loop, weld vertices, slide a loop. Each mutates a working
 * `CageState` (callers pass a copy), keeps the ids of surviving elements and mints ids for new ones. Pure on its inputs.
 */

import type { Vec3 } from '../../model/types';
import { add3, centroid3, scale3, sub3 } from '../../lib/vec3';
import type { CageState } from './cageState';
import { edgeKey } from './edgeKey';
import { mintElementId } from './elements';
import { type CageTopology } from './topology';

/** Drops the vertices no face uses; remaps faces, sharp edges (kept only while they are still edges) and corners. Returns old -> new index (-1 = dropped). */
export function compactState(state: CageState): number[] {
  const used = new Set(state.faces.flat());
  const remap = state.vertices.map((): number => -1);
  let next = 0;
  state.vertices.forEach((_, v) => {
    if (used.has(v)) remap[v] = next++;
  });
  const keep = (list: unknown[]): boolean[] => list.map((_, v) => (remap[v] as number) >= 0);
  const kept = keep(state.vertices);
  const filtered = <T>(list: T[]): T[] => list.filter((_, v) => kept[v]);
  state.vertices.splice(0, state.vertices.length, ...filtered(state.vertices));
  state.vertexIds.splice(0, state.vertexIds.length, ...filtered(state.vertexIds));
  state.faces.forEach((face, f) => (state.faces[f] = face.map((v) => remap[v] as number)));
  const edges = new Set<string>();
  for (const face of state.faces) face.forEach((a, i) => edges.add(edgeKey(a, face[(i + 1) % face.length] as number)));
  const sharp = new Map<string, readonly [number, number, number]>();
  for (const [a, b, s] of state.sharp) {
    const [x, y] = [remap[a] as number, remap[b] as number];
    if (x < 0 || y < 0 || !edges.has(edgeKey(x, y))) continue;
    const key = edgeKey(x, y);
    sharp.set(key, [x, y, Math.max(s, sharp.get(key)?.[2] ?? 0)]);
  }
  state.sharp.splice(0, state.sharp.length, ...sharp.values());
  const corners = new Map<number, number>();
  for (const { v, s } of state.corners)
    if ((remap[v] as number) >= 0) corners.set(remap[v] as number, Math.max(s, corners.get(remap[v] as number) ?? 0));
  state.corners.splice(0, state.corners.length, ...[...corners].map(([v, s]) => ({ v, s })));
  return remap;
}

/** Removes `faces` and every vertex that no remaining face uses. */
export function removeFaces(state: CageState, faces: ReadonlySet<number>): void {
  state.faces.splice(0, state.faces.length, ...state.faces.filter((_, f) => !faces.has(f)));
  state.faceIds.splice(0, state.faceIds.length, ...state.faceIds.filter((_, f) => !faces.has(f)));
  compactState(state);
}

/** Adds the face(s) that close the boundary `loop` (vertices in face-winding order). 'quads' needs an even loop and adds a centre vertex. */
export function fillLoop(state: CageState, loop: readonly number[], mode: 'ngon' | 'quads'): { vertices: number; faces: number } {
  const taken = new Set([...state.vertexIds, ...state.faceIds]);
  const reversed = [...loop].reverse();
  const addFace = (face: number[]): void => {
    state.faces.push(face);
    state.faceIds.push(mintElementId('f', taken));
  };
  if (mode === 'ngon' || loop.length === 4) {
    addFace(reversed);
    return { vertices: 0, faces: 1 };
  }
  const centre = state.vertices.length;
  state.vertices.push(centroid3(loop.map((v) => state.vertices[v] as Vec3)));
  state.vertexIds.push(mintElementId('v', taken));
  const n = reversed.length;
  for (let k = 0; k < n; k += 2) addFace([reversed[k] as number, reversed[k + 1] as number, reversed[(k + 2) % n] as number, centre]);
  return { vertices: 1, faces: n / 2 };
}

/**
 * Merges each cluster of vertices into its lowest-index member (at the cluster centroid when `atCentre`). Faces lose repeated consecutive
 * vertices and vanish below 3 vertices; sharp edges and corners follow the merge. Returns the number of vertices and faces removed.
 */
export function weldClusters(
  state: CageState,
  clusters: ReadonlyArray<readonly number[]>,
  atCentre: boolean,
): { vertices: number; faces: number } {
  const target = state.vertices.map((_, v) => v);
  for (const cluster of clusters) {
    const rep = Math.min(...cluster);
    if (atCentre) state.vertices[rep] = centroid3(cluster.map((v) => state.vertices[v] as Vec3));
    for (const v of cluster) target[v] = rep;
  }
  const facesBefore = state.faces.length;
  const vertexCount = state.vertices.length;
  const survivors: number[] = [];
  state.faces.forEach((face, f) => {
    const mapped = face.map((v) => target[v] as number).filter((v, i, all) => v !== all[(i + all.length - 1) % all.length]);
    if (mapped.length >= 3) {
      state.faces[f] = mapped;
      survivors.push(f);
    }
  });
  state.faces.splice(0, state.faces.length, ...survivors.map((f) => state.faces[f] as number[]));
  state.faceIds.splice(0, state.faceIds.length, ...survivors.map((f) => state.faceIds[f] as string));
  state.sharp.forEach(([a, b, s], i) => (state.sharp[i] = [target[a] as number, target[b] as number, s]));
  state.sharp.splice(0, state.sharp.length, ...state.sharp.filter(([a, b]) => a !== b));
  state.corners.forEach((corner, i) => (state.corners[i] = { v: target[corner.v] as number, s: corner.s }));
  compactState(state);
  return { vertices: vertexCount - state.vertices.length, faces: facesBefore - state.faces.length };
}

export interface SlideProblem {
  readonly message: string;
}

/**
 * Slides the vertices of `chain` (an ordered edge loop or path, a->b as listed) along the rungs that cross it: +factor towards the left of the
 * travel direction seen from outside, -factor towards the right, by |factor| of the rung length. Mutates `state`.
 */
export function slideChain(
  state: CageState,
  topology: CageTopology,
  chain: ReadonlyArray<readonly [number, number]>,
  factor: number,
): SlideProblem | null {
  const order = [chain[0]?.[0] as number, ...chain.map(([, b]) => b)];
  const closed = order.length > 1 && order[0] === order[order.length - 1];
  const vertices = closed ? order.slice(0, -1) : order;
  const original = state.vertices.map((p): Vec3 => [p[0], p[1], p[2]]);
  const after = (face: ReadonlyArray<number>, v: number, steps: number): number =>
    face[(face.indexOf(v) + steps + face.length) % face.length] as number;
  for (const [i, v] of vertices.entries()) {
    const next = closed ? (vertices[(i + 1) % vertices.length] as number) : vertices[i + 1];
    const previous = closed ? (vertices[(i + vertices.length - 1) % vertices.length] as number) : vertices[i - 1];
    // rung on the wanted side: left = the face holding v->next (or prev->v) lies on its left
    const left = factor > 0;
    const faceIndex =
      next !== undefined
        ? topology.directed.get(left ? `${v}>${next}` : `${next}>${v}`)
        : topology.directed.get(left ? `${previous}>${v}` : `${v}>${previous}`);
    if (faceIndex === undefined) return { message: `vertex ${v} has no face on the ${left ? 'left' : 'right'} of the chain` };
    const face = topology.faces[faceIndex] as ReadonlyArray<number>;
    const rung = next !== undefined ? (left ? after(face, v, -1) : after(face, v, 1)) : left ? after(face, v, 1) : after(face, v, -1);
    state.vertices[v] = add3(original[v] as Vec3, scale3(sub3(original[rung] as Vec3, original[v] as Vec3), Math.abs(factor)));
  }
  return null;
}
