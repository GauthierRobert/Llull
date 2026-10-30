/**
 * `quad_remesh` of open meshes and with mirror symmetry (DES-7c leftovers, TECHNICAL_SPEC 13.17) through a stub engine: the pure steps (boundary snap, winding, mirror and
 * weld, symmetry check, the half) and the command around them. The native engine is tested in `server/tests/quadRemeshOpenNative.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { QuadMeshData } from '@core/geometry/mesh/engineTypes';
import {
  type BoundarySnap,
  SYMMETRY_AXIS,
  type SnapProblem,
  halfOf,
  mirrorWeld,
  orientQuadsToSource,
  snapQuadBoundary,
  symmetryProblem,
} from '@core/geometry/mesh/quadOpen';
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

const solved = (result: BoundarySnap | SnapProblem): BoundarySnap => {
  if ('cause' in result) throw new Error(`expected a snap, got ${result.cause}: ${result.message}`);
  return result;
};
const problemOf = (result: BoundarySnap | SnapProblem): SnapProblem => {
  if (!('cause' in result)) throw new Error('expected a problem');
  return result;
};

/**
 * A quadrilateral A (0, 0), B (2, -6), C (10, 9), D (0, 10) in z = 0: its left side DA lies in the plane x = 0 and turns by only 18 degrees at A into AB, so A is a corner of
 * the rim only because the rim joins the plane there. `quads`: an n x n bilinear grid of it whose boundary vertices are off the rim (the left side by +-1e-3 in x and 1e-3 in z,
 * the others pushed 0.2 inwards); `source`: the triangles of the m x m grid of the same map.
 */
function warped(n: number, m: number): { quads: QuadMeshData; source: MeshData } {
  const [A, B, C, D] = [
    [0, 0],
    [2, -6],
    [10, 9],
    [0, 10],
  ] as const;
  const at = (u: number, v: number): [number, number] => [
    (1 - u) * (1 - v) * A[0] + u * (1 - v) * B[0] + u * v * C[0] + (1 - u) * v * D[0],
    (1 - u) * (1 - v) * A[1] + u * (1 - v) * B[1] + u * v * C[1] + (1 - u) * v * D[1],
  ];
  const grid = (count: number): number[] =>
    Array.from({ length: (count + 1) ** 2 }, (_, k) => at((k % (count + 1)) / count, Math.floor(k / (count + 1)) / count)).flat();
  const quadPositions: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      let [x, y] = at(i / n, j / n);
      let z = 0;
      const corner = (i === 0 || i === n) && (j === 0 || j === n);
      if (!corner && (i === 0 || j === 0 || i === n || j === n)) {
        z = 1e-3;
        if (i === 0) x = j % 2 === 0 ? 1e-3 : -1e-3;
        else [x, y] = [x + (5 - x) * 0.04, y + (3 - y) * 0.04];
      }
      // the corner A of the quads is off the rim too (inside it)
      if (i === 0 && j === 0) [x, y] = [0.3, 0.4];
      quadPositions.push(x, y, z);
    }
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const quads: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) quads.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
  const sourceIds = (i: number, j: number): number => j * (m + 1) + i;
  const indices: number[] = [];
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++)
      indices.push(
        sourceIds(i, j),
        sourceIds(i + 1, j),
        sourceIds(i + 1, j + 1),
        sourceIds(i, j),
        sourceIds(i + 1, j + 1),
        sourceIds(i, j + 1),
      );
  const positions = grid(m); // x, y pairs: z = 0 is added below
  const source: number[] = [];
  for (let k = 0; k < positions.length; k += 2) source.push(positions[k] as number, positions[k + 1] as number, 0);
  return { quads: { positions: quadPositions, quads }, source: { positions: source, indices } };
}

describe('snapQuadBoundary', () => {
  it('moves the boundary vertices onto the source rim, keeps the corners exactly and reports loops and the largest move', () => {
    const quads = plateQuads(5, 10, 0.4);
    const result = solved(snapQuadBoundary(plate(), quads.positions, quads.quads, null));
    expect(result.loops).toBe(1);
    expect(result.worstMove).toBeCloseTo(0.4, 12);
    for (let v = 0; v < result.positions.length / 3; v++) {
      const [x, y] = [result.positions[3 * v] as number, result.positions[3 * v + 1] as number];
      const boundary = x === 0 || x === 10 || y === 0 || y === 10;
      if (quads.positions[3 * v] !== x || quads.positions[3 * v + 1] !== y) expect(boundary, `vertex ${v} moved off the rim`).toBe(true);
    }
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

  it('puts the left side, which lies in the plane x = 0, exactly on it (x and z), and the corner where the rim joins the plane exactly on that corner', () => {
    const { quads, source } = warped(6, 24);
    // the jittered input is off the plane on every left vertex that is not a corner
    const left = [...Array(7).keys()].map((j) => j * 7);
    expect(left.slice(1, -1).every((v) => quads.positions[3 * v] !== 0 && quads.positions[3 * v + 2] !== 0)).toBe(true);
    const result = solved(snapQuadBoundary(source, quads.positions, quads.quads, 0));
    for (const v of left) {
      expect(result.positions[3 * v], `left vertex ${v} x`).toBe(0);
      expect(result.positions[3 * v + 2], `left vertex ${v} z`).toBe(0);
    }
    // A (0, 0) is a corner of the rim by the plane join alone (an 18 degree turn); D (0, 10) by its 85 degree turn
    expect([result.positions[0], result.positions[1], result.positions[2]]).toEqual([0, 0, 0]);
    expect([result.positions[3 * 42], result.positions[3 * 42 + 1], result.positions[3 * 42 + 2]]).toEqual([0, 10, 0]);
    expect(result.loops).toBe(1);
  });

  describe('refuses, with its cause and the exact reason', () => {
    const quads = plateQuads(5, 10, 0);
    /** `plate()` and a second plate 30 to the right: a source of two loops. */
    const twin = (): MeshData => {
      const a = plate();
      const offset = a.positions.length / 3;
      return {
        positions: [...a.positions, ...a.positions.map((v, i) => (i % 3 === 0 ? v + 30 : v))],
        indices: [...a.indices, ...a.indices.map((v) => v + offset)],
      };
    };
    const shifted = (mesh: QuadMeshData, dx: number, scale = 1): QuadMeshData => ({
      positions: mesh.positions.map((v, i) => (i % 3 === 0 ? v * scale + dx : i % 3 === 1 ? v * scale : v)),
      quads: mesh.quads,
    });
    const joined = (parts: QuadMeshData[]): QuadMeshData => {
      let offset = 0;
      const out: QuadMeshData = { positions: [], quads: [] };
      for (const part of parts) {
        (out.positions as number[]).push(...part.positions);
        (out.quads as number[]).push(...part.quads.map((v) => v + offset));
        offset += part.positions.length / 3;
      }
      return out;
    };

    it('loops: a different number of loops', () => {
      const far: MeshData = {
        positions: [...plate().positions, 50, 0, 0, 51, 0, 0, 50, 1, 0],
        indices: [...plate().indices, plate().positions.length / 3, plate().positions.length / 3 + 1, plate().positions.length / 3 + 2],
      };
      const result = problemOf(snapQuadBoundary(far, quads.positions, quads.quads, null));
      expect(result).toMatchObject({ cause: 'loops' });
      expect(result.message).toMatch(/^the engine's quads have 1 boundary loop\(s\) against 2 in the source$/);
    });

    it('loops: a quad loop that runs along two source loops', () => {
      // one grid over both plates (x 0 to 40) and a small grid on the second plate: two loops against two, the big one nearest to both
      const wide = shifted(quads, 0);
      const stretched: QuadMeshData = { positions: wide.positions.map((v, i) => (i % 3 === 0 ? v * 4 : v)), quads: wide.quads };
      const small = shifted(plateQuads(2, 10, 0), 30);
      const result = problemOf(snapQuadBoundary(twin(), joined([stretched, small]).positions, joined([stretched, small]).quads, null));
      expect(result).toMatchObject({ cause: 'loops' });
      expect(result.message).toMatch(/^a boundary loop of the engine's quads runs along more than one boundary loop of the source$/);
    });

    it('loops: two quad loops that follow the same source loop', () => {
      const both = joined([quads, shifted(plateQuads(3, 10, 0), 0)]);
      const result = problemOf(snapQuadBoundary(twin(), both.positions, both.quads, null));
      expect(result).toMatchObject({ cause: 'loops' });
      expect(result.message).toMatch(/^two boundary loops of the engine's quads follow the same boundary loop of the source$/);
    });

    it('shape: a loop that does not go once round the rim it follows', () => {
      const corner = plateQuads(2, 2, 0);
      const result = problemOf(snapQuadBoundary(plate(), corner.positions, corner.quads, null));
      expect(result).toMatchObject({ cause: 'shape' });
      expect(result.message).toMatch(/does not go once round the boundary loop of the source it follows$/);
    });

    it("source: a source boundary that branches (two triangles that only meet at a vertex) is the source's problem", () => {
      const bowtie: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0], indices: [0, 1, 2, 0, 3, 4] };
      const result = problemOf(snapQuadBoundary(bowtie, quads.positions, quads.quads, null));
      expect(result).toMatchObject({ cause: 'source' });
      expect(result.message).toMatch(/^the boundary of the source is not a set of simple loops/);
    });

    it('shape: a quad folded or collapsed by the snap with the order of the boundary intact', () => {
      // random interior vertices of a 5 x 5 grid with its boundary pushed inwards: some pull a quad across a boundary vertex, which the snap then folds
      let next = 12345;
      const random = (): number => ((next = (next * 1103515245 + 12345) % 2147483648), next / 2147483648);
      let found: SnapProblem | null = null;
      for (let attempt = 0; attempt < 400 && found === null; attempt++) {
        const grid = plateQuads(5, 10, 0.4);
        const positions = grid.positions.map((v, i) => {
          const [vi, axis] = [Math.floor(i / 3), i % 3];
          const [column, row] = [vi % 6, Math.floor(vi / 6)];
          return axis < 2 && column > 0 && column < 5 && row > 0 && row < 5 ? v + (random() - 0.5) * 6 : v;
        });
        const result = snapQuadBoundary(plate(), positions, grid.quads, null);
        if ('cause' in result && /folds or collapses quad \d+$/.test(result.message)) found = result;
      }
      expect(found, 'a random interior reaches a fold within 400 tries').not.toBeNull();
      expect(found).toMatchObject({ cause: 'shape' });
    });
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
    expect(halfOf(behind, 'yz', 17.3)).toBe('empty');
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
    // the outermost layer of the 6 x 6 plate (20 quads) is replaced by one row of 16 on the rim (the inner boundary has 16 vertices)
    expect(data).toMatchObject({
      open: true,
      boundaryLoops: 1,
      quads: 32,
      boundaryRow: 'realigned',
      boundaryRowQuads: 16,
      boundaryLayerRemoved: 20,
    });
    expect(data['boundaryMove'] as number).toBeGreaterThan(0);
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
    expect(lost.error?.code).toBe('MESH_QUAD_REMESH_BOUNDARY_LOST');
    expect(lost.summary).toContain('engine counts tried: 36, 42, 32');
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

describe('quad_remesh retries and the flat symmetry plane (13.17.6)', () => {
  const { doc, ids } = docWithMeshes(plate());
  const id = ids[0] as string;

  it('asks again at 1.15 x when the first answer lost a loop, and reports the counts sent', () => {
    const seen: QuadOp[] = [];
    // the first answer is a closed sphere (no boundary loop at all), the second a plate that fits
    const engine = stubQuadEngine((op) => (op.targetQuads === 36 ? quadSphere(10, 3) : plateQuads(6, 10, 0.3)), seen);
    const result = execute(doc, 'quad_remesh', { id, targetQuadCount: 36, output: 'mesh' }, contextWith(engine));
    expect(result.error, result.summary).toBeUndefined();
    expect(seen.map((op) => op.targetQuads)).toEqual([36, 42]);
    expect(result.data).toMatchObject({ attempts: 2, engineTargets: [36, 42], quads: 32 });
  });

  it('then asks at 0.87 x, and refuses by name when every answer fails: the loop count -> BOUNDARY_LOST, the shape -> SNAP_FAILED', () => {
    const seen: QuadOp[] = [];
    const lost = execute(
      doc,
      'quad_remesh',
      { id, targetQuadCount: 36, output: 'mesh' },
      contextWith(stubQuadEngine(() => quadSphere(10, 3), seen)),
    );
    expect(lost.error?.code).toBe('MESH_QUAD_REMESH_BOUNDARY_LOST');
    expect(seen.map((op) => op.targetQuads)).toEqual([36, 42, 32]);
    expect(lost.summary).toContain('engine counts tried: 36, 42, 32');
    expect(lost.document).toBe(doc);
    // loops are there but the loop is a corner of the rim only: it cannot be placed
    const corner = plateQuads(2, 2, 0);
    const shape = execute(doc, 'quad_remesh', { id, targetQuadCount: 36, output: 'mesh' }, contextWith(stubQuadEngine(() => corner)));
    expect(shape.error?.code).toBe('MESH_QUAD_REMESH_SNAP_FAILED');
    expect(shape.summary).toContain('engine counts tried: 36, 42, 32');
  });

  it('asks once more for the count that would have given the target when the ratio is under 0.85, and keeps the closer result', () => {
    const seen: QuadOp[] = [];
    // 32 quads for 100 asked (ratio 0.32, the outer layer of 20 quads becomes a row of 16): asked again for ceil(100 / 0.32) = 313, which answers with 96 (a 10 x 10 plate: 64 inner quads and a row of 32)
    const better = execute(
      doc,
      'quad_remesh',
      { id, targetQuadCount: 100, output: 'mesh' },
      contextWith(stubQuadEngine((op) => (op.targetQuads === 100 ? plateQuads(6, 10, 0.3) : plateQuads(10, 10, 0.3)), seen)),
    );
    expect(seen.map((op) => op.targetQuads)).toEqual([100, 313]);
    expect(better.data).toMatchObject({ attempts: 2, engineTargets: [100, 313], quads: 96, targetRatio: 0.96 });
    // the second answer is worse (the ratio 0.1): the first is kept
    const worse = execute(
      doc,
      'quad_remesh',
      { id, targetQuadCount: 100, output: 'mesh' },
      contextWith(stubQuadEngine((op) => (op.targetQuads === 100 ? plateQuads(6, 10, 0.3) : plateQuads(3, 10, 0.3)))),
    );
    expect(worse.data).toMatchObject({ attempts: 2, quads: 32 });
    // a closed source is never asked twice by the ratio rule
    const sphere = docWithMeshes(icosphere(10, 3));
    const closedSeen: QuadOp[] = [];
    execute(
      sphere.doc,
      'quad_remesh',
      { id: sphere.ids[0] as string, targetQuadCount: 400 },
      contextWith(stubQuadEngine(() => quadSphere(10, 3), closedSeen)),
    );
    expect(closedSeen).toHaveLength(1);
  });

  it('refuses a symmetry plane that triangles lie in, by name, with the count', () => {
    const half = halfOf(plate(), 'xy', 14.2);
    expect(half).toEqual({ flat: 288 });
    const refused = execute(
      doc,
      'quad_remesh',
      { id, targetQuadCount: 36, output: 'mesh', symmetry: { plane: 'xy' } },
      contextWith(stubQuadEngine(() => plateQuads(6, 10, 0))),
    );
    expect(refused.error?.code).toBe('MESH_PARAM_INVALID');
    expect(refused.summary).toContain('288 triangle(s) lie in the xy plane');
    expect(refused.document).toBe(doc);
  });
});
