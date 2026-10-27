/** 07 MSH M6: quad_remesh through a stub mesh engine (the command layer: parameters, cage and mesh results, creases, refusals, purity, replay). The native engine is tested in server/tests/quadRemeshNative.test.ts. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { hardEdgeCreases, offSourceProblem, outwardQuads, quadValence, triangulateQuads } from '@core/geometry/mesh/quadCage';
import type { QuadMeshData } from '@core/geometry/mesh/engineTypes';
import type { SubdivisionEntity } from '@core/model/types';
import type { MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cuboid, docWithMeshes, gridMesh, icosphere } from '../../helpers/meshFixtures';
import {
  type QuadOp,
  contextWith,
  insideOut,
  quadBox,
  quadSphere,
  stubQuadEngine,
  tessellatedBox,
  twoShells,
} from '../../helpers/quadFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;

const sphereEngine = (seen: QuadOp[] = []): ReturnType<typeof stubQuadEngine> => stubQuadEngine(() => quadSphere(10, 8), seen);
const { doc: sphereDoc, ids: sphereIds } = docWithMeshes(icosphere(10, 3));
const sphereId = sphereIds[0] as string;

describe('quad_remesh', () => {
  it('creates a subdivision solid whose cage is the quads, keeps the source and reports valence, target ratio and deviation', () => {
    const seen: QuadOp[] = [];
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 400 }, contextWith(sphereEngine(seen)));
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0] as string;
    expect(id).toMatch(/^subd-/);
    expect(result.document.order).toEqual([sphereId, id]);
    const cage = result.document.entities[id] as SubdivisionEntity;
    expect(cage.kind).toBe('subdivision');
    expect([cage.vertices.length, cage.faces.length, cage.levels, cage.creases.length]).toEqual([386, 384, 2, 0]);
    expect(cage.faces.every((face) => face.length === 4)).toBe(true);
    expect(cage.elementIds.vertices).toHaveLength(386);
    expect(cage.elementIds.faces).toHaveLength(384);
    expect(seen).toEqual([{ op: 'quad_remesh', targetQuads: 400, adaptive: false, hardEdgeRad: (30 * Math.PI) / 180 }]);
    const data = dataOf(result);
    expect(data).toMatchObject({
      id,
      sourceId: sphereId,
      output: 'subdivision',
      quads: 384,
      vertices: 386,
      targetQuads: 400,
      irregularVertices: 8,
      creases: 0,
      levels: 2,
      unit: 'mm',
      unverified: true,
      valence: { '3': 8, '4': 378 },
    });
    expect(data['targetRatio']).toBeCloseTo(0.96, 12);
    expect((data['deviation'] as { hausdorff: number }).hausdorff).toBeLessThan(0.5);
    expect((data['defaults'] as Array<{ name: string }>).map((d) => d.name)).toEqual(['detectHardEdgesDeg', 'levels']);
    expect(data['provenance']).toMatchObject({ engine: 'native', deterministic: true });
    expect(result.summary).toContain("quad_remesh '");
    expect(result.summary).toContain('384 quads');
  });

  it('derives the quad count from targetEdgeLength as surface area over length squared', () => {
    const seen: QuadOp[] = [];
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetEdgeLength: 1 }, contextWith(sphereEngine(seen)));
    expect(result.error).toBeUndefined();
    const area = dataOf(result)['areaBefore'] as number;
    expect(seen[0]?.targetQuads).toBe(Math.round(area));
  });

  it('turns hard edges into creases and passes the alignment angle to the engine; 0 switches both off', () => {
    const { doc, ids } = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
    const seen: QuadOp[] = [];
    const engine = stubQuadEngine(() => quadBox(5, 4), seen);
    const hard = execute(
      doc,
      'quad_remesh',
      { id: ids[0] as string, targetQuadCount: 96, detectHardEdgesDeg: 45, adaptiveSize: 20 },
      contextWith(engine),
    );
    expect(hard.error).toBeUndefined();
    const cage = hard.document.entities[hard.affected[0] as string] as SubdivisionEntity;
    expect(cage.creases).toHaveLength(48);
    expect(dataOf(hard)['creases']).toBe(48);
    expect(seen[0]).toMatchObject({ adaptive: true, hardEdgeRad: (45 * Math.PI) / 180 });
    const soft = execute(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 96, detectHardEdgesDeg: 0 }, contextWith(engine));
    expect((soft.document.entities[soft.affected[0] as string] as SubdivisionEntity).creases).toHaveLength(0);
    expect(seen[1]?.hardEdgeRad).toBeUndefined();
  });

  it('makes no crease on a smooth source even when the coarse cage turns by more than the angle', () => {
    const coarse = stubQuadEngine(() => quadSphere(10, 2));
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 24 }, contextWith(coarse));
    expect(result.error).toBeUndefined();
    expect(dataOf(result)['creases']).toBe(0);
  });

  it('output mesh creates a closed triangle mesh of the quads and levels does not apply', () => {
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 400, output: 'mesh' }, contextWith(sphereEngine()));
    expect(result.error).toBeUndefined();
    const id = result.affected[0] as string;
    const mesh = result.document.entities[id] as MeshSolidEntity;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.mesh.indices).toHaveLength(384 * 2 * 3);
    expect(dataOf(result)).toMatchObject({ output: 'mesh', quads: 384, creases: 0 });
    expect(dataOf(result)['levels']).toBeUndefined();
    const analysis = execute(result.document, 'analyze_mesh', { id, selfIntersections: false });
    expect(dataOf(analysis)).toMatchObject({ closed: true, orientationConsistent: true });
    expect(result.document.order).toEqual([sphereId, id]);
  });

  it('reverses an inside-out engine result so the cage faces outward', () => {
    const engine = stubQuadEngine(() => insideOut(quadSphere(10, 6)));
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 200, output: 'mesh' }, contextWith(engine));
    expect(result.error).toBeUndefined();
    const analysis = execute(result.document, 'analyze_mesh', { id: result.affected[0] as string, selfIntersections: false });
    expect(dataOf(analysis)['volume'] as number).toBeGreaterThan(3000);
  });

  it('gives the same ids and result twice (replay) and leaves its input untouched', () => {
    const ctx = contextWith(sphereEngine());
    const a = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 400 }, ctx);
    const b = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 400 }, ctx);
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    expectPure(sphereDoc, () => execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 400 }, ctx));
    const replayed = execute(a.document, 'replay_history', {}, ctx);
    expect(replayed.error).toBeUndefined();
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(a.document.entities));
  });

  it('refuses bad input without touching the document', () => {
    const ctx = contextWith(sphereEngine());
    const run = (params: Record<string, unknown>): ReturnType<typeof execute> => execute(sphereDoc, 'quad_remesh', params, ctx);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: 'nope', targetQuadCount: 100 }, 'MESH_ENTITY_NOT_FOUND'],
      [{ id: sphereId }, 'MESH_PARAM_INVALID'],
      [{ id: sphereId, targetQuadCount: 100, targetEdgeLength: 1 }, 'MESH_PARAM_INVALID'],
      [{ id: sphereId, targetEdgeLength: 1000 }, 'MESH_PARAM_INVALID'],
      [{ id: sphereId, targetEdgeLength: 0.001 }, 'MESH_PARAM_INVALID'],
      [{ id: sphereId, targetQuadCount: 40000, levels: 4 }, 'MESH_PARAM_INVALID'],
    ];
    for (const [params, code] of cases) {
      const result = run(params);
      expectNoOp(result, sphereDoc);
      expect(codeOf(result)).toBe(code);
    }
    expect(codeOf(run({ id: sphereId, targetQuadCount: 3 }))).toBe('CMD_INVALID_PARAMS');
    expect(codeOf(run({ id: sphereId, targetQuadCount: 100, output: 'quads' }))).toBe('CMD_INVALID_PARAMS');
  });

  it('refuses an open mesh, a 2D shape, a missing engine and an engine failure', () => {
    const open = docWithMeshes(gridMesh(10, 4));
    const ctx = contextWith(sphereEngine());
    const notClosed = execute(open.doc, 'quad_remesh', { id: open.ids[0] as string, targetQuadCount: 50 }, ctx);
    expectNoOp(notClosed, open.doc);
    expect(codeOf(notClosed)).toBe('MESH_NOT_CLOSED');
    const line = execute(sphereDoc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(line.affected, line.summary).toHaveLength(1);
    const flat = execute(line.document, 'quad_remesh', { id: line.affected[0] as string, targetQuadCount: 50 }, ctx);
    expect(codeOf(flat)).toBe('MESH_NOT_A_MESH');
    const none = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 100 }, contextWith(null));
    expectNoOp(none, sphereDoc);
    expect(codeOf(none)).toBe('MESH_ENGINE_UNSUPPORTED');
    const failing = stubQuadEngine(() => ({ code: 'MESH_QUAD_REMESH_FAILED', message: 'singular system' }));
    const failed = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 100 }, contextWith(failing));
    expectNoOp(failed, sphereDoc);
    expect(codeOf(failed)).toBe('MESH_QUAD_REMESH_FAILED');
    expect(failed.summary).toContain('singular system');
  });

  it('refuses a subdivision cage above the 50 000 vertex cap and says to lower the target', () => {
    const huge = quadSphere(10, 92);
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 40000 }, contextWith(stubQuadEngine(() => huge)));
    expectNoOp(result, sphereDoc);
    expect(codeOf(result)).toBe('MESH_PARAM_INVALID');
    expect(result.summary).toContain('lower targetQuadCount');
  });

  it('quad_remesh winds two shells outward, one of them inverted by the engine', () => {
    const [left, right] = [icosphere(5, 2), icosphere(5, 2, [20, 0, 0])];
    const offset = left.positions.length / 3;
    const source = docWithMeshes({
      positions: [...left.positions, ...right.positions],
      indices: [...left.indices, ...right.indices.map((i) => i + offset)],
    });
    const engine = stubQuadEngine(() => twoShells(quadSphere(5, 4), insideOut(quadSphere(5, 3)), 20));
    const result = execute(
      source.doc,
      'quad_remesh',
      { id: source.ids[0] as string, targetQuadCount: 200, output: 'mesh' },
      contextWith(engine),
    );
    expect(result.error, result.summary).toBeUndefined();
    const analysis = dataOf(execute(result.document, 'analyze_mesh', { id: result.affected[0] as string, selfIntersections: false }));
    expect(analysis['volume'] as number).toBeGreaterThan(900);
    expect(analysis['shellCount']).toBe(2);
    expect(analysis['orientationConsistent']).toBe(true);
  });

  it('creases a finely tessellated box source (20 x 20 per face) along its 12 edges', () => {
    const { doc, ids } = docWithMeshes(tessellatedBox(5, 20));
    const result = execute(
      doc,
      'quad_remesh',
      { id: ids[0] as string, targetQuadCount: 96 },
      contextWith(stubQuadEngine(() => quadBox(5, 4))),
    );
    expect(result.error).toBeUndefined();
    expect(dataOf(result)['creases']).toBe(48);
  });

  it('accepts a coarse valid cage: the 6-quad cube on a sphere has its corners 12 % of the diagonal inside the source box', () => {
    const cube = quadSphere(10, 1);
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 6 }, contextWith(stubQuadEngine(() => cube)));
    expect(result.error, result.summary).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ quads: 6, vertices: 8, valence: { '3': 8 } });
  });

  it('refuses, with the measured value, a result outside the source box, collapsed, or with a vertex off the surface; none walks the edges', () => {
    const sphere = quadSphere(10, 6);
    const outward = { positions: sphere.positions.map((v, i) => (i % 3 === 0 ? v + 3.5 : v)), quads: sphere.quads };
    const collapsed = quadBox(5e-7, 4);
    const pulled = { positions: sphere.positions.map((v, i) => (i < 3 ? 0 : v)), quads: sphere.quads };
    const cases: Array<[QuadMeshData, string]> = [
      [outward, 'stick out of the source'],
      [collapsed, 'collapsed'],
      [pulled, 'not on the source'],
    ];
    for (const [bad, text] of cases) {
      const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 100 }, contextWith(stubQuadEngine(() => bad)));
      expectNoOp(result, sphereDoc);
      expect(codeOf(result)).toBe('MESH_QUAD_REMESH_FAILED');
      expect(result.summary).toContain(text);
      expect(result.summary).toMatch(/[0-9][.][0-9]/);
    }
  });

  it('refuses out-of-range quad indices instead of looping on them', () => {
    const sphere = quadSphere(10, 4);
    const bad = { positions: sphere.positions, quads: [...sphere.quads.slice(0, -1), 999999] };
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 100 }, contextWith(stubQuadEngine(() => bad)));
    expectNoOp(result, sphereDoc);
    expect(codeOf(result)).toBe('MESH_QUAD_REMESH_FAILED');
  });

  it('refuses a malformed engine result (non-finite coordinate, ragged quad list)', () => {
    const sphere = quadSphere(10, 4);
    for (const bad of [
      { positions: [Number.NaN, ...sphere.positions.slice(1)], quads: sphere.quads },
      { positions: sphere.positions, quads: sphere.quads.slice(0, -1) },
    ]) {
      const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 100 }, contextWith(stubQuadEngine(() => bad)));
      expectNoOp(result, sphereDoc);
      expect(codeOf(result)).toBe('MESH_QUAD_REMESH_FAILED');
    }
  });

  it('refuses a result that is not a closed quad surface', () => {
    const sphere = quadSphere(10, 6);
    const holed = { positions: sphere.positions, quads: sphere.quads.slice(4) };
    const result = execute(sphereDoc, 'quad_remesh', { id: sphereId, targetQuadCount: 100 }, contextWith(stubQuadEngine(() => holed)));
    expectNoOp(result, sphereDoc);
    expect(codeOf(result)).toBe('MESH_QUAD_REMESH_FAILED');
    expect(result.summary).toContain('closed');
  });
});

describe('quad helpers', () => {
  it('valence counts faces around each vertex, ascending', () => {
    const sphere = quadSphere(1, 3);
    expect(quadValence(sphere.quads, sphere.positions.length / 3)).toEqual({ '3': 8, '4': 48 });
  });

  it('outwardQuads keeps an outward mesh and reverses an inside-out one', () => {
    const sphere = quadSphere(1, 2);
    expect(outwardQuads(sphere.positions, sphere.quads)).toEqual(sphere.quads);
    const flipped = insideOut(sphere);
    expect(flipped.quads).not.toEqual(sphere.quads);
    expect(outwardQuads(flipped.positions, flipped.quads)).toEqual(sphere.quads);
  });

  it('hardEdgeCreases keeps the cage edges that follow a hard edge of the source: 48 on a box, none on a smooth surface however coarse the cage', () => {
    const box = quadBox(5, 4);
    const cube = cuboid([-5, -5, -5], [5, 5, 5]);
    expect(hardEdgeCreases(box.positions, box.quads, cube, Math.PI / 4)).toHaveLength(48);
    expect(hardEdgeCreases(box.positions, box.quads, cube, Math.PI)).toHaveLength(0);
    const coarse = quadSphere(10, 2);
    expect(hardEdgeCreases(coarse.positions, coarse.quads, icosphere(10, 3), Math.PI / 6)).toHaveLength(0);
    for (const n of [1, 4, 8, 20])
      expect(hardEdgeCreases(box.positions, box.quads, tessellatedBox(5, n), Math.PI / 6), `source ${n} x ${n} per face`).toHaveLength(48);
    const turned = box.positions.map((v, i, all) =>
      i % 3 === 0
        ? v * Math.SQRT1_2 - (all[i + 1] as number) * Math.SQRT1_2
        : i % 3 === 1
          ? (all[i - 1] as number) * Math.SQRT1_2 + v * Math.SQRT1_2
          : v,
    );
    expect(hardEdgeCreases(turned, box.quads, tessellatedBox(5, 8), Math.PI / 6)).toHaveLength(0);
    const scaled = box.positions.map((v) => v * 1e-7);
    expect(hardEdgeCreases(scaled, box.quads, tessellatedBox(5, 20), Math.PI / 6)).toHaveLength(0);
    const shifted = cuboid([20, 20, 20], [30, 30, 30]);
    expect(hardEdgeCreases(box.positions, box.quads, shifted, Math.PI / 4)).toHaveLength(0);
  });

  it('outwardQuads orients each shell on its own: an inverted shell next to an outward one', () => {
    const mixed = twoShells(quadSphere(10, 3), insideOut(quadSphere(3, 2)), 30);
    const fixed = outwardQuads(mixed.positions, mixed.quads);
    const inner = quadSphere(3, 2);
    const first = quadSphere(10, 3).quads.length;
    expect(fixed.slice(0, first)).toEqual(quadSphere(10, 3).quads);
    expect(fixed.slice(first)).toEqual(inner.quads.map((v) => v + quadSphere(10, 3).positions.length / 3));
  });

  it('offSourceProblem compares each vertex with its own quad edges: a graded cage passes, a vertex pulled off its surface does not', () => {
    // source: the plane z = 0 (two big triangles); cage: one 40 mm quad 5 mm above it (distance 5 < its edges 40) among 50 unit quads on the plane
    const source = { positions: [-100, -100, 0, 100, -100, 0, 100, 100, 0, -100, 100, 0], indices: [0, 1, 2, 0, 2, 3] };
    const positions: number[] = [0, 0, 5, 40, 0, 5, 40, 40, 5, 0, 40, 5];
    const quads: number[] = [0, 1, 2, 3];
    for (let i = 0; i < 50; i++) {
      const base = positions.length / 3;
      positions.push(-50 + 2 * i, -50, 0, -49 + 2 * i, -50, 0, -49 + 2 * i, -49, 0, -50 + 2 * i, -49, 0);
      quads.push(base, base + 1, base + 2, base + 3);
    }
    expect(offSourceProblem(positions, quads, source)).toBeNull();
    const pulled = positions.slice();
    pulled[2 + 3 * 60] = 5;
    expect(offSourceProblem(pulled, quads, source)).toContain('not on the source');
  });

  it('triangulateQuads splits every quad along its shorter diagonal', () => {
    const positions = [0, 0, 0, 1, 0, 0, 5, 1, 0, 0, 1, 0];
    expect(triangulateQuads(positions, [0, 1, 2, 3])).toEqual([0, 1, 3, 1, 2, 3]);
    const tall = [0, 0, 0, 1, 0, 0, 1, 4, 0, 0, 4, 0];
    expect(triangulateQuads(tall, [0, 1, 2, 3])).toEqual([0, 1, 2, 0, 2, 3]);
  });
});
