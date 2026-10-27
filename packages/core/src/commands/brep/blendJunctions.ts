/**
 * The junctions of a chain of blends (DES-6c step 2): the edges where one blend face meets the next blend face of a tangent chain. They are not
 * contacts with a support face, so `check_blends` measured nothing there; a re-skinned chain (profile blends) can open or kink at them.
 * @invariant pure over a topology, its face graph and `chained` (the two faces are blends of one fillet node's profiled chain); each junction is reported
 *   once, from the lower face index. Blends of two steps, or two blends of one circular step, are creases the user asked for, never junctions; a profiled chain across a crease of the part is mitred and judged against `supportCrease` / `judgeJunction`.
 */

import type { ShapeTopology } from '../../geometry/kernel';
import type { FaceGraph } from '../../geometry/kernelPorts';
import { blendSource } from '../../geometry/blend/continuity';

export interface Junction {
  readonly edge: number;
  /** Persistent name of the blend face on the other side. */
  readonly neighbour: string;
}

/** The junction edges of blend face `face` with the higher-indexed blend faces it is not a support of (nor they of it). */
export function junctionsOf(
  topology: ShapeTopology,
  graph: FaceGraph,
  face: number,
  chained: (a: number, b: number) => boolean,
): Junction[] {
  const own = topology.faces[face]?.name;
  const ownSource = own === undefined ? null : blendSource(own);
  if (own === undefined || ownSource === null) return [];
  const found: Junction[] = [];
  for (const [edge, around] of graph.edgeFaces.entries()) {
    if (around.length !== 2 || !around.includes(face)) continue;
    const other = around.find((candidate) => candidate !== face);
    const name = other === undefined ? undefined : topology.faces[other]?.name;
    const source = name === undefined ? null : blendSource(name);
    if (other === undefined || other < face || name === undefined || source === null) continue;
    if (ownSource.supports.includes(name) || source.supports.includes(own) || !chained(face, other)) continue;
    found.push({ edge, neighbour: name });
  }
  return found;
}

/** OCCT chains the edges of a contour across creases of up to about 0.1 rad; a support crease above this (radians) is a corner of the part and gives a junction no allowance. */
export const CHAIN_CREASE_LIMIT = 0.11;
/** Support faces whose normals differ by less than this (radians) are tangent: the noise of the faces, not a crease. */
const CREASE_NOISE = 1e-4;

/**
 * The crease of the part a junction of two blends runs across, read from the SUPPORT faces and not from the blends under test: the largest angle between
 * the normals of a support of `face` and a different support of `neighbour` along the sharp edge those two faces share (`measure` is the kernel's
 * edge continuity: samples with the normal angle `g1`). Of several edges two supports share, the one with an end on the `junction` edge is read. A pair above
 * `CHAIN_CREASE_LIMIT` is skipped (a corner of the part), so it never raises the allowance. 0 when no pair shares an edge (a smooth chain: both blends
 * touch the same supports).
 */
export function supportCrease(
  topology: ShapeTopology,
  graph: FaceGraph,
  face: number,
  neighbour: number,
  junction: number,
  measure: (edge: number) => ReadonlyArray<{ readonly g1: number }> | null,
): number {
  const own = topology.faces[face]?.name;
  const other = topology.faces[neighbour]?.name;
  const ownSource = own === undefined ? null : blendSource(own);
  const otherSource = other === undefined ? null : blendSource(other);
  if (ownSource === null || otherSource === null) return 0;
  let crease = 0;
  for (const a of ownSource.supports) {
    for (const b of otherSource.supports) {
      if (a === b) continue;
      const first = topology.faces.findIndex((candidate) => candidate.name === a);
      const second = topology.faces.findIndex((candidate) => candidate.name === b);
      const edge = sharedEdge(topology, graph, first, second, junction);
      if (first < 0 || second < 0 || edge < 0) continue;
      const found = Math.max(0, ...(measure(edge) ?? []).map((sample) => sample.g1));
      if (found <= CHAIN_CREASE_LIMIT) crease = Math.max(crease, found);
    }
  }
  return crease > CREASE_NOISE ? crease : 0;
}

/** The edge faces `first` and `second` share that touches the `junction` edge (nearest end to end when several), -1 when they share none. */
function sharedEdge(topology: ShapeTopology, graph: FaceGraph, first: number, second: number, junction: number): number {
  const ends = (edge: number): Array<readonly [number, number, number]> => {
    const entry = topology.edges[edge];
    return entry === undefined ? [] : [entry.start, entry.end];
  };
  const reach = (edge: number): number =>
    Math.min(Infinity, ...ends(edge).flatMap((a) => ends(junction).map((b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))));
  let best = -1;
  graph.edgeFaces.forEach((around, edge) => {
    if (around.length !== 2 || !around.includes(first) || !around.includes(second)) return;
    if (best < 0 || reach(edge) < reach(best)) best = edge;
  });
  return best;
}

/**
 * What a junction may add to the normal angle: `allowance` is its support crease (0 for a smooth chain, which keeps the plain rule exactly), and
 * `endsOff` how far the angle at either end of the junction is from what the supports there give, 0 (both blends touch the same support) or the crease
 * (each touches its own): more than `g1AngleRad` off both is a defect of the blend, not the part's crease.
 */
export function judgeJunction(
  samples: ReadonlyArray<{ readonly g1: number }>,
  crease: number,
  g1AngleRad: number,
): { readonly allowance: number; readonly endsOff: number; readonly limit: number } {
  const ends = [samples[0]?.g1 ?? 0, samples[samples.length - 1]?.g1 ?? 0];
  const endsOff = crease === 0 ? 0 : Math.max(...ends.map((angle) => Math.min(Math.abs(angle), Math.abs(angle - crease))));
  return { allowance: crease, endsOff, limit: g1AngleRad + crease };
}
