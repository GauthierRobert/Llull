/**
 * Vertices of an exact solid from its edges (BLD M3, TECHNICAL_SPEC §3): the kernel lists edges with their end points, so a vertex is a cluster of
 * coincident end points and its persistent name `v(<edge name>,<edge name>,...)` (names sorted) is derived from the names of the edges that meet
 * there, resolved like edge names: exactly one vertex with that name, none = lost, several = split.
 * @invariant a vertex is named only when every edge meeting there has a persistent name (kernels without history name nothing)
 * @failure an empty topology -> no vertices
 */

import type { Vec3 } from '../../model/types';
import type { ShapeTopology } from '../kernel';
import { distance3 } from '../../lib/vec3';

export interface SolidVertex {
  readonly point: Vec3;
  /** Unique-edge indices of the non-degenerate edges meeting here, ascending. */
  readonly edges: readonly number[];
  /** `v(<names of the edges>)`, absent without persistent edge names. */
  readonly name?: string;
}

/** End points closer than this fraction of the bounding-box diagonal of the solid's vertices are the same vertex (the native build uses the same rule). */
const COINCIDENT = 1e-7;

const nameOf = (names: readonly (string | undefined)[]): string | undefined =>
  names.every((name): name is string => name !== undefined && name.length > 0) ? `v(${[...names].sort().join(',')})` : undefined;

/** The distinct vertices of `topology` (end points of non-degenerate edges). */
export function solidVertices(topology: ShapeTopology): readonly SolidVertex[] {
  const points: Vec3[] = [];
  const meeting: number[][] = [];
  const ends = topology.edges.flatMap((edge) => [edge.start, edge.end]);
  const span = [0, 1, 2].map(
    (axis) => Math.max(...ends.map((point) => point[axis] ?? 0)) - Math.min(...ends.map((point) => point[axis] ?? 0)),
  );
  const tolerance = COINCIDENT * Math.max(Math.hypot(...span), 1e-9);
  for (const edge of topology.edges) {
    if (edge.degenerate) continue;
    for (const point of [edge.start, edge.end]) {
      let at = points.findIndex((known) => distance3(known, point) <= tolerance);
      if (at < 0) {
        points.push(point);
        meeting.push([]);
        at = points.length - 1;
      }
      const list = meeting[at];
      if (list !== undefined && !list.includes(edge.index)) list.push(edge.index);
    }
  }
  return points.map((point, at) => {
    const edges = [...(meeting[at] ?? [])].sort((a, b) => a - b);
    const name = nameOf(edges.map((index) => topology.edges[index]?.name));
    return name === undefined ? { point, edges } : { point, edges, name };
  });
}

/** Index of the vertex nearest `point`, or -1 when there is none. */
export function nearestVertex(vertices: readonly SolidVertex[], point: Vec3): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const [at, vertex] of vertices.entries()) {
    const gap = distance3(vertex.point, point);
    if (gap < bestDistance) {
      best = at;
      bestDistance = gap;
    }
  }
  return best;
}

export type VertexResolution =
  | { readonly ok: true; readonly index: number }
  | { readonly ok: false; readonly lost: boolean; readonly name: string };

/** The vertex called `name`: exactly one match is found, none is lost, several are split. */
export function resolveVertexName(vertices: readonly SolidVertex[], name: string): VertexResolution {
  const found = vertices.flatMap((vertex, at) => (vertex.name === name ? [at] : []));
  const [only] = found;
  return found.length === 1 && only !== undefined ? { ok: true, index: only } : { ok: false, lost: found.length === 0, name };
}
