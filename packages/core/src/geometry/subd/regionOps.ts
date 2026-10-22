/**
 * Face-region topology operations of a cage (04 DIR §5.3): extrude and inset share one construction. The boundary vertices of each
 * region are duplicated and moved, the region's faces are rewired to the duplicates and one side quad per boundary edge joins old to new
 * (winding preserved, closed stays closed). Surviving elements keep their ids; new ones are minted. Pure on its inputs.
 */

import type { Vec3 } from '../../model/types';
import { add3, cross3, dot3, len3, normalize3, normalize3OrZero, scale3, sub3 } from '../../lib/vec3';
import type { CageState } from './cageState';
import { edgeKey } from './edgeKey';
import { mintElementId } from './elements';
import { type CageTopology, buildTopology, connectedRegions, newellVector, regionBoundary } from './topology';

/** Position of vertex `v` of region `k` after the operation (`boundary`: v is duplicated, else it moves in place). */
type Place = (k: number, v: number, boundary: boolean) => Vec3;

/** Regions of `faces`: edge-connected components, or one per face when `individual`. */
export function regionsOf(topology: CageTopology, faces: readonly number[], individual: boolean): number[][] {
  return individual ? [...new Set(faces)].sort((a, b) => a - b).map((f) => [f]) : connectedRegions(topology, faces);
}

/** Area-weighted unit normal of a region, or null when its faces cancel out. */
export function regionNormal(vertices: ReadonlyArray<Vec3>, topology: CageTopology, region: readonly number[]): Vec3 | null {
  const total = region.reduce<Vec3>((sum, f) => add3(sum, newellVector(vertices, topology.faces[f] as ReadonlyArray<number>)), [0, 0, 0]);
  return len3(total) < 1e-12 ? null : normalize3(total);
}

/**
 * Applies a region sweep to `state` (mutated: pass a working copy). `place` reads the positions of `snapshot`, the vertices before the sweep.
 * Returns the number of vertices and faces created.
 */
export function sweepRegions(state: CageState, regions: readonly number[][], place: Place): { vertices: number; faces: number } {
  const topology = buildTopology(state.vertices.length, state.faces);
  const taken = new Set([...state.vertexIds, ...state.faceIds]);
  const duplicates: Array<Map<number, number>> = [];
  const firstVertex = state.vertices.length;
  const firstFace = state.faces.length;
  regions.forEach((region, k) => {
    const members = new Set(region);
    const boundary = regionBoundary(topology, members);
    const onBoundary = [...new Set(boundary.flatMap(([a, b]) => [a, b]))];
    const dup = new Map<number, number>();
    for (const v of onBoundary) {
      dup.set(v, state.vertices.length);
      state.vertices.push(place(k, v, true));
      state.vertexIds.push(mintElementId('v', taken));
    }
    const interior = new Set(region.flatMap((f) => topology.faces[f] as ReadonlyArray<number>).filter((v) => !dup.has(v)));
    for (const v of interior) state.vertices[v] = place(k, v, false);
    for (const f of region) state.faces[f] = (topology.faces[f] as ReadonlyArray<number>).map((v) => dup.get(v) ?? v);
    for (const [a, b] of boundary) {
      state.faces.push([a, b, dup.get(b) as number, dup.get(a) as number]);
      state.faceIds.push(mintElementId('f', taken));
    }
    duplicates.push(dup);
  });
  carrySharpness(state, topology, regions, duplicates);
  return { vertices: state.vertices.length - firstVertex, faces: state.faces.length - firstFace };
}

/** Sharpness follows the sweep: interior region edges move with their endpoints, boundary edges are copied onto the new rim. */
function carrySharpness(
  state: CageState,
  topology: CageTopology,
  regions: readonly number[][],
  duplicates: Array<Map<number, number>>,
): void {
  const sets = regions.map((region) => new Set(region));
  const out: Array<readonly [number, number, number]> = [];
  for (const [a, b, s] of state.sharp) {
    const faces = (topology.edges[topology.edgeIndex.get(edgeKey(a, b)) as number] as { faces: number[] }).faces;
    let moved = false;
    const copies: Array<readonly [number, number, number]> = [];
    sets.forEach((members, k) => {
      const inside = faces.filter((f) => members.has(f)).length;
      const dup = duplicates[k] as Map<number, number>;
      if (inside === 2) {
        out.push([dup.get(a) ?? a, dup.get(b) ?? b, s]);
        moved = true;
      } else if (inside === 1) copies.push([dup.get(a) as number, dup.get(b) as number, s]);
    });
    if (!moved) out.push([a, b, s]);
    out.push(...copies);
  }
  state.sharp.splice(0, state.sharp.length, ...out);
  duplicates.forEach((dup) => {
    for (const corner of [...state.corners]) if (dup.has(corner.v)) state.corners.push({ v: dup.get(corner.v) as number, s: corner.s });
  });
}

/** Placer of an extrusion: every vertex of region k moves by `offsets[k]`. */
export const translatePlace =
  (vertices: ReadonlyArray<Vec3>, offsets: readonly Vec3[]): Place =>
  (k, v) =>
    add3(vertices[v] as Vec3, offsets[k] as Vec3);

export interface InsetPlan {
  readonly place: Place;
  /** A cap face turns over or shrinks to nothing at this thickness. */
  readonly collapsed: boolean;
}

/** Placer of an inset by `thickness` (in the face plane, even by default) and `depth` (along the region normal), plus its validity. */
export function insetPlan(
  vertices: ReadonlyArray<Vec3>,
  topology: CageTopology,
  regions: readonly number[][],
  normals: readonly Vec3[],
  thickness: number,
  depth: number,
  even: boolean,
): InsetPlan {
  const offsets = regions.map((region) => {
    const members = new Set(region);
    const inward = new Map<number, Vec3[]>();
    for (const [a, b] of regionBoundary(topology, members)) {
      const face = topology.faces[topology.directed.get(`${a}>${b}`) as number] as ReadonlyArray<number>;
      const m = normalize3OrZero(cross3(normalize3OrZero(newellVector(vertices, face)), sub3(vertices[b] as Vec3, vertices[a] as Vec3)));
      for (const v of [a, b]) inward.set(v, [...(inward.get(v) ?? []), m]);
    }
    return new Map([...inward].map(([v, list]): [number, Vec3] => [v, cornerOffset(list, thickness, even)]));
  });
  const place: Place = (k, v, boundary) => {
    const lift = scale3(normals[k] as Vec3, depth);
    const flat = boundary ? ((offsets[k] as Map<number, Vec3>).get(v) as Vec3) : ([0, 0, 0] as Vec3);
    return add3(add3(vertices[v] as Vec3, flat), lift);
  };
  const collapsed = regions.some((region, k) => {
    const members = new Set(region);
    const boundary = regionBoundary(topology, members);
    const onBoundary = new Set(boundary.flatMap(([a, b]) => [a, b]));
    const moved = (v: number): Vec3 => place(k, v, onBoundary.has(v));
    // an inset edge keeps its direction until it shrinks to nothing; past that it points backwards
    const reversed = boundary.some(([a, b]) => {
      const [before, after] = [sub3(vertices[b] as Vec3, vertices[a] as Vec3), sub3(moved(b), moved(a))];
      return dot3(after, before) <= 1e-9 * dot3(before, before);
    });
    return (
      reversed ||
      region.some((f) => {
        const face = topology.faces[f] as ReadonlyArray<number>;
        const now = newellVector(
          face.map(moved),
          face.map((_, i) => i),
        );
        const before = newellVector(vertices, face);
        return len3(now) < 1e-12 || dot3(now, before) <= 1e-9 * len3(now) * len3(before);
      })
    );
  });
  return { place, collapsed };
}

/** Offset of a boundary vertex whose boundary edges have inward unit normals `list`: exactly `thickness` from each edge when `even`. */
function cornerOffset(list: readonly Vec3[], thickness: number, even: boolean): Vec3 {
  const sum = list.reduce<Vec3>((total, m) => add3(total, m), [0, 0, 0]);
  if (even && list.length === 2) {
    const [m1, m2] = list as [Vec3, Vec3];
    const denominator = 1 + dot3(m1, m2);
    if (denominator > 1e-9) return scale3(sum, thickness / denominator);
  }
  return scale3(normalize3OrZero(sum), thickness);
}
