/**
 * `quad_remesh` of open meshes and with mirror symmetry on the native engine (DES-7c leftovers, TECHNICAL_SPEC 13.17): an open mesh keeps its boundary (every boundary
 * loop of the quads lies on one boundary loop of the source), `symmetry` gives quads that are exactly mirror-symmetric, and what stays unsupported is refused by name.
 * Native runs need llull-compute (cargo build in solver/) and are skipped with a logged reason otherwise.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument, MeshSolidEntity, SubdivisionEntity } from '@core/model/types';
import { docWithMeshes, gridMesh, icosphere } from '../../tests/helpers/meshFixtures';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('quadRemeshOpenNative: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });
const context = (): ExecutionContext => ({ ...defaultContext(), meshProcessing: engine });
const exec = (doc: CadDocument, params: unknown): Promise<CommandResult> => {
  _clearResultCache();
  return resolveDeferred(() => execute(doc, 'quad_remesh', params, context()));
};

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;

/** The upper hemisphere of an icosphere: the triangles whose corners all have z >= 0 (one boundary loop, the equator). */
function hemisphere(level: number): { positions: number[]; indices: number[] } {
  const sphere = icosphere(10, level);
  const indices: number[] = [];
  for (let t = 0; t < sphere.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => sphere.indices[t + k] as number);
    if (corners.every((v) => (sphere.positions[3 * v + 2] as number) > -1e-9)) indices.push(...corners);
  }
  return { positions: sphere.positions, indices };
}

/** Boundary vertices (edges used by one triangle) of a triangle mesh entity, with the number of boundary edges. */
function boundaryOf(mesh: MeshSolidEntity['mesh']): { vertices: number[][]; edges: number } {
  const uses = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[t + k] as number;
      const b = mesh.indices[t + ((k + 1) % 3)] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  const ends = new Set<number>();
  let edges = 0;
  for (const [key, n] of uses)
    if (n === 1) {
      edges++;
      for (const v of key.split(',').map(Number)) ends.add(v);
    }
  return {
    vertices: [...ends].map((v) => [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]] as number[]),
    edges,
  };
}

/** The distance from `p` to the nearest boundary edge (used by one triangle) of the triangle mesh `mesh`. */
function distanceToBoundary(p: number[], mesh: { positions: readonly number[]; indices: readonly number[] }): number {
  const uses = new Map<string, [number, number]>();
  const counts = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[t + k] as number;
      const b = mesh.indices[t + ((k + 1) % 3)] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      uses.set(key, [a, b]);
    }
  let best = Infinity;
  for (const [key, n] of counts) {
    if (n !== 1) continue;
    const [a, b] = uses.get(key) as [number, number];
    const A = [0, 1, 2].map((c) => mesh.positions[3 * a + c] as number);
    const B = [0, 1, 2].map((c) => mesh.positions[3 * b + c] as number);
    const ab = [0, 1, 2].map((c) => (B[c] as number) - (A[c] as number));
    const len2 = ab.reduce((sum, v) => sum + v * v, 0);
    const t =
      len2 === 0 ? 0 : Math.min(1, Math.max(0, ab.reduce((sum, v, c) => sum + v * ((p[c] as number) - (A[c] as number)), 0) / len2));
    best = Math.min(best, Math.hypot(...[0, 1, 2].map((c) => (p[c] as number) - ((A[c] as number) + t * (ab[c] as number)))));
  }
  return best;
}

/** Every vertex of `positions` has its mirror image (negated `axis`) among the vertices, exactly. */
function mirrorSymmetric(positions: readonly number[], axis: number): boolean {
  const key = (p: number[]): string => p.map((c) => (c === 0 ? 0 : c)).join(',');
  const all = new Set<string>();
  for (let v = 0; v < positions.length; v += 3)
    all.add(key([positions[v] as number, positions[v + 1] as number, positions[v + 2] as number]));
  for (let v = 0; v < positions.length; v += 3) {
    const p = [positions[v] as number, positions[v + 1] as number, positions[v + 2] as number];
    p[axis] = -(p[axis] as number);
    if (!all.has(key(p))) return false;
  }
  return true;
}

describe('quad_remesh of an open mesh on the native engine (13.17)', () => {
  const { doc, ids } = docWithMeshes(hemisphere(4));
  const id = ids[0] as string;

  native('a hemisphere keeps its rim: one boundary loop of quads on the equator, mesh output, near the target', async () => {
    const result = await exec(doc, { id, targetQuadCount: 300, output: 'mesh' });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    expect(data).toMatchObject({ open: true, boundaryLoops: 1, output: 'mesh' });
    expect(data['targetRatio'] as number).toBeGreaterThan(0.7);
    expect(data['targetRatio'] as number).toBeLessThan(1.3);
    // the largest move of a boundary vertex is under one quad edge (the area is 628 for 300 quads: an edge of 1.5)
    expect(data['boundaryMove'] as number).toBeLessThan(1.5);
    const entity = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    const rim = boundaryOf(entity.mesh);
    expect(rim.edges).toBeGreaterThan(20);
    // every boundary vertex of the quads lies on the boundary of the source (its jagged rim: the icosphere has no clean equator)
    for (const p of rim.vertices) expect(distanceToBoundary(p, hemisphere(4))).toBeLessThan(1e-9);
    expect((data['deviation'] as { hausdorff: number }).hausdorff).toBeLessThan(1);
    expect(result.summary).toContain('1 boundary loop(s) kept');
  });

  native('a square plate keeps its four corners, one boundary loop, and stays flat', async () => {
    const { doc: plateDoc, ids: plateIds } = docWithMeshes(gridMesh(10, 30));
    const result = await exec(plateDoc, { id: plateIds[0] as string, targetQuadCount: 100, output: 'mesh' });
    expect(result.error, result.summary).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ open: true, boundaryLoops: 1 });
    const entity = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(entity.mesh.positions.filter((_, i) => i % 3 === 2).every((z) => Math.abs(z) < 1e-9)).toBe(true);
    // the four corners of the plate are vertices of the result, exactly
    for (const corner of [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as const) {
      const found = [...Array(entity.mesh.positions.length / 3).keys()].some(
        (v) => entity.mesh.positions[3 * v] === corner[0] && entity.mesh.positions[3 * v + 1] === corner[1],
      );
      expect(found, `corner ${corner}`).toBe(true);
    }
    expect(dataOf(result)['boundaryMove'] as number).toBeLessThan(1.5);
  });

  native('a plate with a square hole is refused by name: the engine does not keep the hole', async () => {
    const plate = gridMesh(10, 30);
    const kept: number[] = [];
    for (let t = 0; t < plate.indices.length / 3; t++) {
      const cell = Math.floor(t / 2);
      const [i, j] = [cell % 30, Math.floor(cell / 30)];
      if (!(i >= 10 && i < 20 && j >= 10 && j < 20)) kept.push(...plate.indices.slice(3 * t, 3 * t + 3));
    }
    const { doc: holedDoc, ids: holedIds } = docWithMeshes({ positions: plate.positions, indices: kept });
    const result = await exec(holedDoc, { id: holedIds[0] as string, targetQuadCount: 200, output: 'mesh' });
    // the engine keeps the hole's loop at this count; the snap then folds quad 172 (a loop count mismatch is the stub test's BOUNDARY_LOST)
    expect(result.error?.code).toBe('MESH_QUAD_REMESH_SNAP_FAILED');
    expect(result.summary).toMatch(/folds or collapses quad \d+ \(engine counts tried: 200, 230, 174\)/);
    expect(holedDoc.entities[holedIds[0] as string]).toBeDefined();
    expect(result.document).toBe(holedDoc);
  });

  native('output "subdivision" of an open mesh is refused by name, and so is a non-symmetric source with symmetry', async () => {
    const cage = await exec(doc, { id, targetQuadCount: 300 });
    expect(cage.error?.code).toBe('MESH_NOT_CLOSED');
    expect(cage.summary).toContain('output "mesh"');
    const moved = icosphere(10, 3);
    const shifted = { positions: moved.positions.map((v, i) => (i % 3 === 0 ? v + 2 : v)), indices: moved.indices };
    const { doc: shiftedDoc, ids: shiftedIds } = docWithMeshes(shifted);
    const refused = await exec(shiftedDoc, { id: shiftedIds[0] as string, targetQuadCount: 100, symmetry: { plane: 'yz' } });
    expect(refused.error?.code).toBe('MESH_QUAD_REMESH_NOT_SYMMETRIC');
    expect(refused.summary).toContain('not symmetric about the yz plane');
  });
});

describe('quad_remesh with mirror symmetry on the native engine (13.17)', () => {
  const { doc: ballDoc, ids: ballIds } = docWithMeshes(icosphere(10, 4));
  const ballId = ballIds[0] as string;

  native('a sphere in every plane: exactly mirror-symmetric quads, closed, near the target', async () => {
    for (const [plane, axis] of [
      ['yz', 0],
      ['xz', 1],
      ['xy', 2],
    ] as const) {
      const result = await exec(ballDoc, { id: ballId, targetQuadCount: 600, output: 'mesh', symmetry: { plane } });
      expect(result.error, `${plane}: ${result.summary}`).toBeUndefined();
      const data = dataOf(result);
      expect(data).toMatchObject({ symmetry: { plane }, open: false });
      expect(data['targetRatio'] as number).toBeGreaterThan(0.6);
      expect(data['targetRatio'] as number).toBeLessThan(1.4);
      const entity = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
      expect(mirrorSymmetric(entity.mesh.positions, axis), plane).toBe(true);
      expect(boundaryOf(entity.mesh).edges, `${plane}: closed`).toBe(0);
      const valence = data['valence'] as Record<string, number>;
      expect(
        Object.entries(valence).reduce((sum, [k, n]) => sum + (4 - Number(k)) * n, 0),
        plane,
      ).toBe(8);
    }
  });

  native('the cage of a symmetric remesh is a closed subdivision solid and its vertices are symmetric', async () => {
    const result = await exec(ballDoc, { id: ballId, targetQuadCount: 400, symmetry: { plane: 'xz' } });
    expect(result.error, result.summary).toBeUndefined();
    const cage = result.document.entities[result.affected[0] as string] as SubdivisionEntity;
    expect(cage.kind).toBe('subdivision');
    expect(cage.vertices.length - cage.faces.length).toBe(2);
    expect(mirrorSymmetric(cage.vertices.flat(), 1)).toBe(true);
  });

  native('a symmetric open mesh keeps its rim and is mirror-symmetric', async () => {
    const { doc, ids } = docWithMeshes(hemisphere(4));
    const result = await exec(doc, { id: ids[0] as string, targetQuadCount: 300, output: 'mesh', symmetry: { plane: 'yz' } });
    expect(result.error, result.summary).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ open: true, boundaryLoops: 1, symmetry: { plane: 'yz' } });
    const entity = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(mirrorSymmetric(entity.mesh.positions, 0)).toBe(true);
    // the rim of the half that was remeshed and mirrored: on the source rim, which is symmetric about yz as a set of segments
    for (const p of boundaryOf(entity.mesh).vertices) expect(distanceToBoundary(p, hemisphere(4))).toBeLessThan(1e-6);
  });
});
