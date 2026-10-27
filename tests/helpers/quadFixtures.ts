/** Quad meshes for the quad_remesh tests: a cube-grid quad mesh mapped onto a sphere or kept as a box, and a stub mesh engine that answers `quad_remesh` with them. */

import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { triangulateQuads } from '@core/geometry/mesh/quadCage';
import type { IndexedMesh } from './meshFixtures';
import type { MeshEngineFailure, MeshOp, MeshOpResult, MeshProcessingEngine, QuadMeshData } from '@core/geometry/mesh/engineTypes';

type V = [number, number, number];
export type QuadOp = Extract<MeshOp, { op: 'quad_remesh' }>;

/**
 * The six faces of the cube [-1, 1]^3, each an n x n grid of quads welded on the shared edges, wound outward, with every vertex passed through
 * `place`. 6 n^2 quads, 6 n^2 + 2 vertices, eight valence-3 corners.
 */
function cubeGridQuads(n: number, place: (cube: V) => V): QuadMeshData {
  const ids = new Map<string, number>();
  const positions: number[] = [];
  const quads: number[] = [];
  const vertex = (c: V): number => {
    const key = c.map((x) => Math.round(x * n * 4)).join(',');
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(...place(c));
      ids.set(key, id);
    }
    return id;
  };
  for (const axis of [0, 1, 2]) {
    for (const side of [-1, 1]) {
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          const corner = (da: number, db: number): V => {
            const [u, v] = [-1 + (2 * (a + da)) / n, -1 + (2 * (b + db)) / n];
            const c: V = [0, 0, 0];
            c[axis] = side;
            c[(axis + 1) % 3] = u;
            c[(axis + 2) % 3] = v;
            return c;
          };
          const [c0, c1, c2, c3] = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
          // the grid axes (axis+1, axis+2) are right-handed about +axis, so the quad faces +axis exactly when side is +1
          const outward = side > 0;
          const order = outward ? [c0, c1, c2, c3] : [c0, c3, c2, c1];
          quads.push(...order.map(vertex));
        }
      }
    }
  }
  return { positions, quads };
}

/** Quad sphere of `radius` (6 n^2 quads). */
export const quadSphere = (radius: number, n: number): QuadMeshData =>
  cubeGridQuads(n, ([x, y, z]) => {
    const length = Math.hypot(x, y, z);
    return [(x / length) * radius, (y / length) * radius, (z / length) * radius];
  });

/** Quad box of half-size `half` centred on the origin (6 n^2 quads). */
export const quadBox = (half: number, n: number): QuadMeshData => cubeGridQuads(n, ([x, y, z]) => [x * half, y * half, z * half]);

/** Box of half-size `half` as triangles: n x n quads per face, each split in two (the source of a finely tessellated box). */
export function tessellatedBox(half: number, n: number): IndexedMesh {
  const quads = quadBox(half, n);
  return { positions: [...quads.positions], indices: triangulateQuads(quads.positions, quads.quads) };
}

/** `b` placed beside `a` in one quad mesh (two shells), `b` moved by `offset` along x. */
export function twoShells(a: QuadMeshData, b: QuadMeshData, offset: number): QuadMeshData {
  const shifted = b.positions.map((v, i) => (i % 3 === 0 ? v + offset : v));
  return { positions: [...a.positions, ...shifted], quads: [...a.quads, ...b.quads.map((v) => v + a.positions.length / 3)] };
}

/** The quads with every quad reversed (inside out). */
export const insideOut = (mesh: QuadMeshData): QuadMeshData => ({
  positions: mesh.positions,
  quads: mesh.quads.flatMap((_, i, all) =>
    i % 4 === 0 ? [all[i] as number, all[i + 3] as number, all[i + 2] as number, all[i + 1] as number] : [],
  ),
});

const PROVENANCE: MeshOpResult['provenance'] = {
  engine: 'native',
  version: 'stub',
  algorithm: 'stub quad remesher',
  reference: 'tests/helpers/quadFixtures.ts',
  deterministic: true,
};

/** A mesh engine answering only `quad_remesh`, with the result of `answer`; every op it receives is appended to `seen`. */
export function stubQuadEngine(answer: (op: QuadOp) => QuadMeshData | MeshEngineFailure, seen: QuadOp[] = []): MeshProcessingEngine {
  return {
    name: 'stub-quad',
    capabilities: () => new Map([['quad_remesh', Infinity]]),
    run(_, op) {
      if (op.op !== 'quad_remesh') return { code: 'MESH_ENGINE_UNSUPPORTED', message: 'stub' };
      seen.push(op);
      const result = answer(op);
      return 'code' in result ? result : { quads: result, report: {}, provenance: PROVENANCE };
    },
  };
}

export const contextWith = (engine: MeshProcessingEngine | null): ExecutionContext => ({ ...defaultContext(), meshProcessing: engine });
