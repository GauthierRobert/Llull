/** Structured tetrahedral meshes for tests (each cell split into 6 Kuhn tets around its 0-7 diagonal) and a seeded generator. */
import type { FeMeshArtifact } from '@core/model/analysis';

type GridNodes = FeMeshArtifact['nodes'];

export interface GridMesh {
  readonly nodes: GridNodes;
  /** Node-id lists, CalculiX order (C3D10: corners then mid-edges 12, 23, 31, 14, 24, 34). */
  readonly elements: number[][];
}

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
] as const;
const EDGES = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
] as const;

export interface GridOptions {
  readonly cells: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly origin?: readonly [number, number, number];
  readonly firstNodeId?: number;
  readonly quadratic?: boolean;
}

/** A box of `cells` hexahedral cells, each split into 6 tetrahedra; node ids start at `firstNodeId` (default 1). */
export function gridMesh(options: GridOptions): GridMesh {
  const [nx, ny, nz] = options.cells;
  const [sx, sy, sz] = options.size;
  const [ox, oy, oz] = options.origin ?? [0, 0, 0];
  const first = options.firstNodeId ?? 1;
  const nodes: [number, number, number, number][] = [];
  const id = (i: number, j: number, k: number): number => first + i + (nx + 1) * (j + (ny + 1) * k);
  for (let k = 0; k <= nz; k += 1)
    for (let j = 0; j <= ny; j += 1)
      for (let i = 0; i <= nx; i += 1) nodes.push([id(i, j, k), ox + (sx * i) / nx, oy + (sy * j) / ny, oz + (sz * k) / nz]);
  const position = new Map(nodes.map((node) => [node[0], node]));
  const middles = new Map<string, number>();
  let next = first + nodes.length;
  const middle = (a: number, b: number): number => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const known = middles.get(key);
    if (known !== undefined) return known;
    const [pa, pb] = [position.get(a), position.get(b)];
    const created = next;
    next += 1;
    nodes.push([
      created,
      ((pa?.[1] ?? 0) + (pb?.[1] ?? 0)) / 2,
      ((pa?.[2] ?? 0) + (pb?.[2] ?? 0)) / 2,
      ((pa?.[3] ?? 0) + (pb?.[3] ?? 0)) / 2,
    ]);
    middles.set(key, created);
    return created;
  };
  const elements: number[][] = [];
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1)
      for (let i = 0; i < nx; i += 1) {
        const corner = (v: number): number => id(i + (v & 1), j + ((v >> 1) & 1), k + (v >> 2));
        for (const tet of KUHN) {
          const corners = tet.map(corner);
          elements.push(
            options.quadratic === true ? [...corners, ...EDGES.map(([a, b]) => middle(corners[a] ?? 0, corners[b] ?? 0))] : corners,
          );
        }
      }
  return { nodes, elements };
}

/** Deterministic pseudo-random numbers in [0, 1) (LCG, 31-bit). */
export function seeded(seed: number): () => number {
  let state = seed % 2147483647;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
