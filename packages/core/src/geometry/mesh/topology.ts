/** Edge, shell, boundary-loop and orientation structure of a welded indexed triangle mesh. */

interface BoundaryLoop {
  /** Vertex indices around the loop, in boundary-edge direction. */
  readonly vertices: number[];
}

export interface MeshTopology {
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly edgeCount: number;
  /** Edges used by exactly one face, as directed `[from, to]` of that face. */
  readonly boundaryEdges: Array<readonly [number, number]>;
  /** Edges used by more than two faces. */
  readonly nonManifoldEdges: Array<{ readonly a: number; readonly b: number; readonly uses: number }>;
  /** Edges whose two faces traverse it in the same direction (orientation disagreement). */
  readonly inconsistentEdges: number;
  /** Faces on an edge whose two faces disagree on direction (one face per such edge). */
  readonly inconsistentFaces: ReadonlySet<number>;
  /** Shell (edge-connected component) of each face (-1 for a degenerate face, which belongs to none) and the number of shells. */
  readonly faceShell: Int32Array;
  readonly shellCount: number;
  readonly loops: BoundaryLoop[];
  /** Faces repeating a vertex index. */
  readonly degenerateFaces: number[];
  /** Faces with the same vertex set as an earlier face (either winding). */
  readonly duplicateFaces: number[];
}

interface EdgeUse {
  uses: number;
  /** Uses running low index -> high index. */
  forward: number;
  first: number;
}

class UnionFind {
  private readonly parent: Int32Array;
  constructor(size: number) {
    this.parent = Int32Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while ((this.parent[root] ?? root) !== root) root = this.parent[root] ?? root;
    let current = x;
    while (current !== root) {
      const next = this.parent[current] ?? root;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

function chainLoops(boundary: ReadonlyArray<readonly [number, number]>): BoundaryLoop[] {
  const outgoing = new Map<number, number[]>();
  boundary.forEach(([from], edge) => {
    const list = outgoing.get(from);
    if (list === undefined) outgoing.set(from, [edge]);
    else list.push(edge);
  });
  const used = new Uint8Array(boundary.length);
  const loops: BoundaryLoop[] = [];
  for (let start = 0; start < boundary.length; start++) {
    if (used[start] === 1) continue;
    const vertices: number[] = [];
    let edge = start;
    for (;;) {
      used[edge] = 1;
      const [from, to] = boundary[edge] as readonly [number, number];
      vertices.push(from);
      const next = (outgoing.get(to) ?? []).find((candidate) => used[candidate] !== 1);
      if (next === undefined) break;
      edge = next;
    }
    loops.push({ vertices });
  }
  return loops;
}

/** Topology of a welded mesh (`triangles`: 3 corner indices per face over `vertexCount` vertices). */
export function buildTopology(vertexCount: number, triangles: ReadonlyArray<number>): MeshTopology {
  const faceCount = Math.floor(triangles.length / 3);
  const edges = new Map<number, EdgeUse>();
  const faceSets = new Map<string, number>();
  const degenerateFaces: number[] = [];
  const duplicateFaces: number[] = [];
  const unions = new UnionFind(faceCount);
  const key = (a: number, b: number): number => Math.min(a, b) * vertexCount + Math.max(a, b);
  for (let face = 0; face < faceCount; face++) {
    const corners = [triangles[face * 3] as number, triangles[face * 3 + 1] as number, triangles[face * 3 + 2] as number];
    const [a, b, c] = corners as [number, number, number];
    if (a === b || b === c || a === c) {
      degenerateFaces.push(face);
      continue;
    }
    const setKey = [...corners].sort((x, y) => x - y).join(',');
    if (faceSets.has(setKey)) duplicateFaces.push(face);
    else faceSets.set(setKey, face);
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const id = key(from, to);
      const edge = edges.get(id);
      if (edge === undefined) edges.set(id, { uses: 1, forward: from < to ? 1 : 0, first: face });
      else {
        edge.uses++;
        if (from < to) edge.forward++;
        unions.union(edge.first, face);
      }
    }
  }
  const boundaryEdges: Array<readonly [number, number]> = [];
  const nonManifoldEdges: Array<{ a: number; b: number; uses: number }> = [];
  let inconsistentEdges = 0;
  const inconsistentFaces = new Set<number>();
  for (let face = 0; face < faceCount; face++) {
    const [a, b, c] = [triangles[face * 3] as number, triangles[face * 3 + 1] as number, triangles[face * 3 + 2] as number];
    if (a === b || b === c || a === c) continue;
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const edge = edges.get(key(from, to)) as EdgeUse;
      if (edge.uses === 1) boundaryEdges.push([from, to]);
    }
  }
  for (const [id, edge] of edges) {
    if (edge.uses > 2) nonManifoldEdges.push({ a: Math.floor(id / vertexCount), b: id % vertexCount, uses: edge.uses });
    else if (edge.uses === 2 && edge.forward !== 1) {
      inconsistentEdges++;
      inconsistentFaces.add(edge.first);
    }
  }
  nonManifoldEdges.sort((x, y) => x.a - y.a || x.b - y.b);
  const roots = new Map<number, number>();
  const faceShell = new Int32Array(faceCount);
  const degenerate = new Set(degenerateFaces);
  for (let face = 0; face < faceCount; face++) {
    if (degenerate.has(face)) {
      faceShell[face] = -1;
      continue;
    }
    const root = unions.find(face);
    let shell = roots.get(root);
    if (shell === undefined) {
      shell = roots.size;
      roots.set(root, shell);
    }
    faceShell[face] = shell;
  }
  return {
    vertexCount,
    faceCount,
    edgeCount: edges.size,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    inconsistentFaces,
    faceShell,
    shellCount: roots.size,
    loops: chainLoops(boundaryEdges),
    degenerateFaces,
    duplicateFaces,
  };
}
