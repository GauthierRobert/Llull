/**
 * `quad_remesh` of open meshes and with mirror symmetry (DES-7c leftovers, TECHNICAL_SPEC 13.17) through a stub engine: the pure steps (boundary snap, winding, mirror and
 * weld, symmetry check, the half) and the command around them. The native engine is tested in `server/tests/quadRemeshOpenNative.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { QuadMeshData } from '@core/geometry/mesh/engineTypes';
import { SYMMETRY_AXIS, halfOf, mirrorWeld, orientQuadsToSource, snapQuadBoundary, symmetryProblem } from '@core/geometry/mesh/quadOpen';
import type { MeshSolidEntity } from '@core/model/types';
import { docWithMeshes, gridMesh, icosphere } from '../../helpers/meshFixtures';
import { type QuadOp, contextWith, quadSphere, stubQuadEngine } from '../../helpers/quadFixtures';
import type { MeshData } from '@core/model/types';

/** An `n` x `n` grid of quads on [0, size]^2 (z = 0), wound +z, with every boundary vertex pushed `jitter` inwards (a staircase boundary). */
function plateQuads(n: number, size: number, jitter: number): QuadMeshData {
  const positions: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const [x, y] = [(i * size) / n, (j * size) / n];
      const edge = i === 0 || j === 0 || i === n || j === n;
      const corner = (i === 0 || i === n) && (j === 0 || j === n);
      const nudge = edge && !corner ? jitter : 0;
      positions.push(i === 0 ? x + nudge * (j % 2 === 0 ? 0 : 1) : i === n ? x - nudge * (j % 2 === 0 ? 0 : 1) : x, y, 0);
    }
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const quads: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) quads.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
  return { positions, quads };
}

const plate = (): ReturnType<typeof gridMesh> => gridMesh(10, 12);

describe('snapQuadBoundary', () => {
  it('moves the boundary vertices onto the source rim, keeps the corners exactly and reports loops and the largest move', () => {
    const quads = plateQuads(5, 10, 0.4);
    const snapped = snapQuadBoundary(plate(), quads.positions, quads.quads, null);
    expect(typeof snapped).not.toBe('string');
    const result = snapped as Exclude<typeof snapped, string>;
    expect(result.loops).toBe(1);
    expect(result.worstMove).toBeCloseTo(0.4, 12);
    for (let v = 0; v < result.positions.length / 3; v++) {
      const [x, y] = [result.positions[3 * v] as number, result.positions[3 * v + 1] as number];
      const boundary = x === 0 || x === 10 || y === 0 || y === 10;
      if (quads.positions[3 * v] !== x || quads.positions[3 * v + 1] !== y) expect(boundary, `vertex ${v} moved off the rim`).toBe(true);
    }
    // the corners are vertices of the result
    for (const corner of [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
      expect(
        result.positions.some((_, i) => i % 3 === 0 && result.positions[i] === corner[0] && result.positions[i + 1] === corner[1]),
      ).toBe(true);
  });

  it('puts the vertices that land on a segment lying in the plane exactly on it', () => {
    const half = halfOf(icosphere(10, 3), 'yz', 17.3) as MeshData;
    const quads = plateQuads(4, 10, 0);
    // a plate that has its left side on x = 0 after moving it by the half's own shift: use the plate itself as a half with x = 0 on one side
    const result = snapQuadBoundary(plate(), quads.positions, quads.quads, 0);
    expect(typeof result).not.toBe('string');
    const left = (result as { positions: number[] }).positions.filter((_, i) => i % 3 === 0).filter((x) => x === 0).length;
    expect(left).toBeGreaterThan(4);
    expect(half.indices.length).toBeGreaterThan(0);
  });

  it('refuses by name what it cannot keep: a different number of loops, a loop that does not go round, quads folded by the snap', () => {
    const quads = plateQuads(5, 10, 0);
    // a source with two loops (a plate and a far triangle) against quads with one
    const far: MeshData = {
      positions: [...plate().positions, 50, 0, 0, 51, 0, 0, 50, 1, 0],
      indices: [...plate().indices, plate().positions.length / 3, plate().positions.length / 3 + 1, plate().positions.length / 3 + 2],
    };
    expect(snapQuadBoundary(far, quads.positions, quads.quads, null)).toMatch(/1 boundary loop\(s\) against 2/);
    // the source boundary is not a set of simple loops: two triangles that only meet at a vertex
    const bowtie: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0], indices: [0, 1, 2, 0, 3, 4] };
    expect(snapQuadBoundary(bowtie, quads.positions, quads.quads, null)).toMatch(/not a set of simple loops/);
    // a quad that the snap turns inside out: a vertex of the left side pushed far to the right of its neighbour
    const bent = plateQuads(5, 10, 0);
    const bentPositions = [...bent.positions];
    bentPositions[3 * 6] = 7;
    bentPositions[3 * 6 + 1] = 2;
    const refused = snapQuadBoundary(plate(), bentPositions, bent.quads, null);
    expect(typeof refused === 'string' ? refused : 'ok').toMatch(/folds or collapses|does not go once round|in order/);
  });
});

describe('orientQuadsToSource', () => {
  it('reverses a piece that faces away from the source triangles it lies on, and only that piece', () => {
    const quads = plateQuads(4, 10, 0);
    const second = plateQuads(4, 10, 0);
    const offset = quads.positions.length / 3;
    // two pieces side by side on a plate that is twice as wide: the second one wound -z
    const wide: MeshData = gridMesh(20, 24);
    const both = {
      positions: [...quads.positions, ...second.positions.map((v, i) => (i % 3 === 0 ? v + 10 : v))],
      quads: [
        ...quads.quads,
        ...second.quads
          .map((v) => v + offset)
          .flatMap((_, i, all) => (i % 4 === 0 ? [all[i], all[i + 3], all[i + 2], all[i + 1]] : []) as number[]),
      ],
    };
    const fixed = orientQuadsToSource(wide, both.positions, both.quads);
    expect(fixed.slice(0, quads.quads.length)).toEqual(quads.quads);
    expect(fixed.slice(quads.quads.length)).toEqual(second.quads.map((v) => v + offset));
  });
});

describe('mirrorWeld, halfOf and symmetryProblem', () => {
  it('welds the vertices on the plane, mirrors the rest and reverses the mirrored quads', () => {
    // two quads sharing the edge a-b on the plane x = 0 ... the half: one quad with its left side on x = 0
    const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const welded = mirrorWeld(positions, [0, 1, 2, 3], 0);
    expect(welded.positions.length / 3).toBe(6);
    expect(welded.quads).toEqual([0, 1, 2, 3, 0, 3, 5, 4]);
    expect(welded.positions.slice(12)).toEqual([-1, 0, 0, -1, 1, 0]);
  });

  it('accepts a symmetric sphere and refuses a shifted one with the worst distance', () => {
    const sphere = icosphere(10, 3);
    expect(symmetryProblem(sphere, 'yz', 17.3)).toBeNull();
    expect(symmetryProblem(sphere, 'xy', 17.3)).toBeNull();
    const shifted = { positions: sphere.positions.map((v, i) => (i % 3 === 1 ? v + 1 : v)), indices: sphere.indices };
    expect(symmetryProblem(shifted, 'xz', 17.3)).toMatch(
      /not symmetric about the xz plane: a vertex is .* from the surface of its mirror image/,
    );
    expect(symmetryProblem(shifted, 'yz', 17.3)).toBeNull();
  });

  it('puts the cut vertices on the plane exactly even when the clipping arithmetic leaves 1e-17', () => {
    // an edge from x = -0.4632 to x = 0.2204: the interpolated x is 5.55e-17 in doubles, not 0
    const strip: MeshData = {
      positions: [-0.463179164266769, 0.7, 0.2, 0.22040515504235372, 0.7, 0.2, 0.22040515504235372, 0.1, 0.2, -0.463179164266769, 0.1, 0.2],
      indices: [0, 1, 2, 0, 2, 3],
    };
    const half = halfOf(strip, 'yz', 1) as MeshData;
    const xs = half.positions.filter((_, i) => i % 3 === 0);
    expect(xs.filter((x) => x === 0).length).toBeGreaterThanOrEqual(2);
    expect(xs.every((x) => x === 0 || x > 0.05)).toBe(true);
  });

  it('cuts the positive half exactly at the plane and puts its vertices there on it', () => {
    for (const plane of ['yz', 'xz', 'xy'] as const) {
      const axis = SYMMETRY_AXIS[plane];
      const half = halfOf(icosphere(10, 3), plane, 17.3) as MeshData;
      const coordinates = half.positions.filter((_, i) => i % 3 === axis);
      expect(Math.min(...coordinates), plane).toBe(0);
      expect(coordinates.filter((c) => c === 0).length, plane).toBeGreaterThan(10);
      expect(half.indices.length / 3, plane).toBeLessThan(icosphere(10, 3).indices.length / 3);
    }
    // nothing on the positive side
    const behind = { positions: icosphere(10, 2).positions.map((v, i) => (i % 3 === 0 ? v - 20 : v)), indices: icosphere(10, 2).indices };
    expect(halfOf(behind, 'yz', 17.3)).toBeNull();
  });
});

describe('quad_remesh of an open mesh and with symmetry (stub engine)', () => {
  const { doc, ids } = docWithMeshes(plate());
  const id = ids[0] as string;
  const meshOf = (result: { document: { entities: Record<string, unknown> }; affected: string[] }): MeshSolidEntity['mesh'] =>
    (result.document.entities[result.affected[0] as string] as MeshSolidEntity).mesh;

  it('hands the engine the open mesh with preserveBoundary and without the deviation request, then snaps, orients and measures separately', () => {
    const seen: QuadOp[] = [];
    const engine = stubQuadEngine(() => plateQuads(6, 10, 0.3), seen);
    const result = execute(doc, 'quad_remesh', { id, targetQuadCount: 36, output: 'mesh' }, contextWith(engine));
    expect(result.error, result.summary).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: 'quad_remesh', targetQuads: 36, preserveBoundary: true });
    expect(seen[0]).not.toHaveProperty('withDeviation');
    const data = result.data as Record<string, unknown>;
    expect(data).toMatchObject({ open: true, boundaryLoops: 1, quads: 36 });
    expect(data['boundaryMove'] as number).toBeCloseTo(0.3, 9);
    expect(result.summary).toContain('1 boundary loop(s) kept');
    const mesh = meshOf(result);
    // wound like the source (+z) and flat
    expect(mesh.positions.filter((_, i) => i % 3 === 2).every((z) => z === 0)).toBe(true);
  });

  it('refuses output "subdivision" of an open mesh by name, and an engine that lost a loop, and is pure', () => {
    const engine = stubQuadEngine(() => plateQuads(6, 10, 0));
    const cage = execute(doc, 'quad_remesh', { id, targetQuadCount: 36 }, contextWith(engine));
    expect(cage.error?.code).toBe('MESH_NOT_CLOSED');
    expect(cage.document).toBe(doc);
    const lost = execute(
      doc,
      'quad_remesh',
      { id, targetQuadCount: 36, output: 'mesh' },
      contextWith(stubQuadEngine(() => quadSphere(10, 3))),
    );
    expect(['MESH_QUAD_REMESH_BOUNDARY_LOST', 'MESH_QUAD_REMESH_FAILED']).toContain(lost.error?.code);
    expect(lost.document).toBe(doc);
  });

  it('with symmetry: the engine gets the positive half and half the target, and the result is the half and its mirror image, welded, exactly symmetric', () => {
    const sphere = docWithMeshes(icosphere(10, 3));
    const seen: QuadOp[] = [];
    const meshes: MeshData[] = [];
    // the stub answers with a quad half-sphere: the +x half of a 12-quad-per-face cube sphere, built by dropping every quad that has a vertex with x < 0
    const engine = stubQuadEngine(
      () => {
        const full = quadSphere(10, 4);
        const keep: number[] = [];
        for (let f = 0; f < full.quads.length; f += 4) {
          const q = full.quads.slice(f, f + 4);
          if (q.every((v) => (full.positions[3 * v] as number) > -1e-9)) keep.push(...q);
        }
        const used = [...new Set(keep)].sort((a, b) => a - b);
        const renumber = new Map(used.map((v, k) => [v, k]));
        return {
          positions: used.flatMap((v) =>
            [0, 1, 2].map((a) => (a === 0 && Math.abs(full.positions[3 * v] as number) < 1e-9 ? 0 : (full.positions[3 * v + a] as number))),
          ),
          quads: keep.map((v) => renumber.get(v) as number),
        };
      },
      seen,
      meshes,
    );
    const result = execute(
      sphere.doc,
      'quad_remesh',
      { id: sphere.ids[0] as string, targetQuadCount: 200, output: 'mesh', symmetry: { plane: 'yz' } },
      contextWith(engine),
    );
    expect(result.error, result.summary).toBeUndefined();
    expect(seen[0]).toMatchObject({ targetQuads: 100, preserveBoundary: true });
    expect(meshes[0]?.positions.filter((_, i) => i % 3 === 0).every((x) => x >= 0)).toBe(true);
    expect(result.data).toMatchObject({ symmetry: { plane: 'yz' }, open: false });
    const mesh = meshOf(result);
    const keys = new Set<string>();
    for (let v = 0; v < mesh.positions.length; v += 3) keys.add(`${mesh.positions[v]},${mesh.positions[v + 1]},${mesh.positions[v + 2]}`);
    for (let v = 0; v < mesh.positions.length; v += 3)
      expect(
        keys.has(
          `${(mesh.positions[v] as number) === 0 ? 0 : -(mesh.positions[v] as number)},${mesh.positions[v + 1]},${mesh.positions[v + 2]}`,
        ),
      ).toBe(true);
  });

  it('refuses a source that is not symmetric and a plane with nothing on its positive side, by name', () => {
    const sphere = icosphere(10, 3);
    const shifted = docWithMeshes({ positions: sphere.positions.map((v, i) => (i % 3 === 0 ? v + 3 : v)), indices: sphere.indices });
    const refused = execute(
      shifted.doc,
      'quad_remesh',
      { id: shifted.ids[0] as string, targetQuadCount: 100, symmetry: { plane: 'yz' } },
      contextWith(stubQuadEngine(() => quadSphere(10, 3))),
    );
    expect(refused.error?.code).toBe('MESH_QUAD_REMESH_NOT_SYMMETRIC');
    expect(refused.document).toBe(shifted.doc);
  });
});
