/** Adjacency of a polygon cage and per-face geometry (04 DIR §5.3). Pure; used by every cage query and topology operation. */

import type { Vec3 } from '../../model/types';
import { add3, cross3, len3 } from '../../lib/vec3';
import { edgeKey } from './edgeKey';

interface CageEdge {
  readonly a: number;
  readonly b: number;
  /** Faces using the edge (two for a closed cage). */
  readonly faces: number[];
}

export interface CageTopology {
  readonly vertexCount: number;
  readonly faces: ReadonlyArray<ReadonlyArray<number>>;
  readonly edges: CageEdge[];
  /** `edgeKey(a, b)` -> index in `edges`. */
  readonly edgeIndex: Map<string, number>;
  /** `"a>b"` -> the face that holds the directed edge a->b. */
  readonly directed: Map<string, number>;
  readonly vertexEdges: number[][];
  readonly vertexFaces: number[][];
}

/** Edges (in first-seen order), directed-edge map and vertex fans of `faces`. */
export function buildTopology(vertexCount: number, faces: ReadonlyArray<ReadonlyArray<number>>): CageTopology {
  const edges: CageEdge[] = [];
  const edgeIndex = new Map<string, number>();
  const directed = new Map<string, number>();
  const vertexEdges = Array.from({ length: vertexCount }, (): number[] => []);
  const vertexFaces = Array.from({ length: vertexCount }, (): number[] => []);
  faces.forEach((face, f) =>
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      directed.set(`${a}>${b}`, f);
      vertexFaces[a]?.push(f);
      const key = edgeKey(a, b);
      const existing = edgeIndex.get(key);
      if (existing === undefined) {
        edgeIndex.set(key, edges.length);
        vertexEdges[a]?.push(edges.length);
        vertexEdges[b]?.push(edges.length);
        edges.push({ a, b, faces: [f] });
      } else (edges[existing] as CageEdge).faces.push(f);
    }),
  );
  return { vertexCount, faces, edges, edgeIndex, directed, vertexEdges, vertexFaces };
}

/** Vertices joined to `v` by an edge. */
export function neighbourVertices(topology: CageTopology, v: number): number[] {
  return (topology.vertexEdges[v] as number[]).map((e) => {
    const edge = topology.edges[e] as CageEdge;
    return edge.a === v ? edge.b : edge.a;
  });
}

/** Newell vector of a face: its unit normal times twice its area (zero for a degenerate face). */
export function newellVector(vertices: ReadonlyArray<Vec3>, face: ReadonlyArray<number>): Vec3 {
  let total: Vec3 = [0, 0, 0];
  face.forEach((a, i) => {
    const p = vertices[a] as Vec3;
    const q = vertices[face[(i + 1) % face.length] as number] as Vec3;
    total = add3(total, cross3(p, q));
  });
  return total;
}

export const faceArea = (vertices: ReadonlyArray<Vec3>, face: ReadonlyArray<number>): number => len3(newellVector(vertices, face)) / 2;

/** Faces of the cage grouped into edge-connected components of `faces`. */
export function connectedRegions(topology: CageTopology, faces: readonly number[]): number[][] {
  const selected = new Set(faces);
  const seen = new Set<number>();
  const regions: number[][] = [];
  for (const start of [...selected].sort((x, y) => x - y)) {
    if (seen.has(start)) continue;
    const region: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const f = stack.pop() as number;
      region.push(f);
      const face = topology.faces[f] as ReadonlyArray<number>;
      face.forEach((a, i) => {
        const b = face[(i + 1) % face.length] as number;
        const g = topology.directed.get(`${b}>${a}`);
        if (g !== undefined && selected.has(g) && !seen.has(g)) {
          seen.add(g);
          stack.push(g);
        }
      });
    }
    regions.push(region.sort((x, y) => x - y));
  }
  return regions;
}

/** Directed boundary edges (a->b as wound in the region) of `region`: edges whose twin belongs to a face outside it. */
export function regionBoundary(topology: CageTopology, region: ReadonlySet<number>): Array<readonly [number, number]> {
  const boundary: Array<readonly [number, number]> = [];
  for (const f of [...region].sort((x, y) => x - y)) {
    const face = topology.faces[f] as ReadonlyArray<number>;
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      const twin = topology.directed.get(`${b}>${a}`);
      if (twin === undefined || !region.has(twin)) boundary.push([a, b]);
    });
  }
  return boundary;
}
