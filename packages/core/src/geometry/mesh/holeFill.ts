/**
 * Hole filling after Liepa (SGP 2003): boundary loop -> dynamic-programming triangulation -> centroid refinement -> membrane / thin-plate
 * fairing of the inserted vertices (07 MSH FR-MSH-06). Existing vertices and faces are never changed; patch faces are appended.
 * @invariant the filled loops become interior edges (the mesh gains no boundary edge and no non-manifold edge)
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { EditMesh, normalOf } from './editMesh';
import { type Fairing, LIEPA_ALPHA, fairVertices, refinePatch } from './holeRefine';
import { type LoopGeometry, triangulateLoop } from './holeTriangulate';
import { buildTopology } from './topology';

export type HoleSelect = 'all' | ReadonlyArray<number> | { readonly near: ReadonlyArray<Vec3> };

export interface FillOptions {
  readonly select: HoleSelect;
  readonly maxBoundaryEdges: number;
  readonly fairing: Fairing;
  readonly refine: boolean;
  /** Liepa density factor (default sqrt 2). */
  readonly alpha?: number;
}

export interface FilledHole {
  readonly loop: number;
  readonly edges: number;
  readonly triangles: number;
  readonly addedVertices: number;
  readonly area: number;
  readonly triangulation: 'dp' | 'greedy';
  readonly fairing: Fairing;
}

export interface SkippedHole {
  readonly loop: number;
  readonly edges: number;
  readonly code: 'MESH_HOLE_TOO_LARGE' | 'MESH_HOLE_NON_SIMPLE' | 'MESH_HOLE_NO_TRIANGULATION';
}

export interface FillResult {
  readonly mesh: MeshData;
  readonly totalLoops: number;
  readonly filled: FilledHole[];
  readonly skipped: SkippedHole[];
  /** Selection error (an index or point that names no loop). */
  readonly notFound: string | null;
  /** True when the selection was explicit (indices or points) rather than `all`. */
  readonly explicit: boolean;
}

function selectLoops(
  select: HoleSelect,
  loops: ReadonlyArray<{ vertices: number[] }>,
  mesh: EditMesh,
): { list: number[]; notFound: string | null } {
  if (select === 'all') return { list: loops.map((_, i) => i), notFound: null };
  if (Array.isArray(select)) {
    const bad = (select as ReadonlyArray<number>).find((i) => i < 0 || i >= loops.length);
    if (bad !== undefined) return { list: [], notFound: `boundary loop ${bad} does not exist (the mesh has ${loops.length})` };
    return { list: [...new Set(select as ReadonlyArray<number>)].sort((a, b) => a - b), notFound: null };
  }
  const near = (select as { near: ReadonlyArray<Vec3> }).near;
  const chosen = new Set<number>();
  for (const point of near) {
    let best = -1;
    let bestDistance = Infinity;
    loops.forEach((loop, index) => {
      for (const v of loop.vertices) {
        const p = mesh.p(v);
        const d = Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]);
        if (d < bestDistance) {
          bestDistance = d;
          best = index;
        }
      }
    });
    if (best < 0) return { list: [], notFound: `no boundary loop near [${point.join(', ')}]: the mesh has none` };
    chosen.add(best);
  }
  return { list: [...chosen].sort((a, b) => a - b), notFound: null };
}

function geometryOf(mesh: EditMesh, loop: ReadonlyArray<number>): LoopGeometry {
  return {
    position: (v) => mesh.p(v),
    outsideNormal: (i) => {
      const [a, b] = [loop[i] as number, loop[(i + 1) % loop.length] as number];
      const face = mesh.facesOnEdge(a, b)[0];
      if (face === undefined) return null;
      const n = mesh.faceNormal(face);
      const length = Math.hypot(...n);
      return length > 0 ? [n[0] / length, n[1] / length, n[2] / length] : null;
    },
    edgeExists: (a, b) => mesh.facesOnEdge(a, b).length > 0,
  };
}

function meanEdge(mesh: EditMesh, v: number): number {
  const ring = mesh.ring(v);
  const p = mesh.p(v);
  const total = ring.reduce((sum, w) => {
    const q = mesh.p(w);
    return sum + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  }, 0);
  return ring.length > 0 ? total / ring.length : 0;
}

/** Fill the selected boundary loops of the welded mesh `positions` / `triangles`. */
export function fillHoles(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>, options: FillOptions): FillResult {
  const mesh = new EditMesh(positions, triangles);
  const topology = buildTopology(positions.length / 3, triangles);
  const { list, notFound } = selectLoops(options.select, topology.loops, mesh);
  const filled: FilledHole[] = [];
  const skipped: SkippedHole[] = [];
  const explicit = options.select !== 'all';
  if (notFound === null) {
    for (const index of list) {
      const loop = (topology.loops[index] as { vertices: number[] }).vertices;
      if (new Set(loop).size !== loop.length || loop.length < 3) {
        skipped.push({ loop: index, edges: loop.length, code: 'MESH_HOLE_NON_SIMPLE' });
        continue;
      }
      if (loop.length > options.maxBoundaryEdges) {
        skipped.push({ loop: index, edges: loop.length, code: 'MESH_HOLE_TOO_LARGE' });
        continue;
      }
      const sigma = new Map<number, number>(loop.map((v) => [v, meanEdge(mesh, v)]));
      const patch = triangulateLoop(loop, geometryOf(mesh, loop));
      if (patch === null) {
        skipped.push({ loop: index, edges: loop.length, code: 'MESH_HOLE_NO_TRIANGULATION' });
        continue;
      }
      const patchFaces = new Set<number>(patch.triangles.map(([a, b, c]) => mesh.addFace(a, b, c)));
      const inserted = options.refine ? refinePatch(mesh, patchFaces, sigma, options.alpha ?? LIEPA_ALPHA) : [];
      if (options.fairing !== 'none') fairVertices(mesh, inserted, options.fairing);
      let area = 0;
      for (const f of patchFaces) {
        const [a, b, c] = mesh.corners(f);
        area += Math.hypot(...normalOf(mesh.p(a), mesh.p(b), mesh.p(c))) / 2;
      }
      filled.push({
        loop: index,
        edges: loop.length,
        triangles: patchFaces.size,
        addedVertices: inserted.length,
        area,
        triangulation: patch.method,
        fairing: options.fairing,
      });
    }
  }
  return { mesh: mesh.toMeshData(), totalLoops: topology.loops.length, filled, skipped, notFound, explicit };
}
