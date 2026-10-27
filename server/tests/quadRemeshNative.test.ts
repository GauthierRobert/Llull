/**
 * 07 MSH M6 / VC-MSH-22 (the quad_remesh part): `quad_remesh` on the native engine (`llull-compute meshops`, QuadriFlow). An icosphere of radius 10
 * becomes a closed all-quad cage with eight valence-3 corners and every other vertex valence 4, within 15 % of the requested count and 0.1 mm of
 * the source; the cage is a subdivision solid that the native OCC kernel turns into one bicubic B-spline face per refined quad. `fit_subdivision_to_mesh`
 * (the other half of VC-MSH-22) is a later step. Native runs need llull-compute (cargo build --release in solver/) and are skipped with a logged
 * reason otherwise; the B-spline part also needs the native kernel.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { setGeometryKernel } from '@core/geometry/kernel';
import { MESH_ENGINE_PENDING, resolveMeshEngine } from '@core/geometry/mesh/engine';
import type { MeshOpResult, MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { outwardQuads, triangulateQuads } from '@core/geometry/mesh/quadCage';
import { engineDeviation } from '@core/commands/mesh/runMeshOp';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { type CadDocument, type Entity, type MeshData, type MeshSolidEntity, type SubdivisionEntity } from '@core/model/types';
import { cuboid, docWithMeshes, icosphere, torus } from '../../tests/helpers/meshFixtures';
import { tessellatedBox } from '../../tests/helpers/quadFixtures';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { describeNative, leaf, liveKernels } from './kernelTestSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('quadRemeshNative: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });
const context = (): ExecutionContext => ({ ...defaultContext(), meshProcessing: engine });
/** `execute` as the host runs it: the native job is awaited between two runs of the command (TECHNICAL_SPEC 13.8). */
const exec = (doc: CadDocument, name: string, params: unknown, ctx: ExecutionContext = context()): Promise<CommandResult> =>
  resolveDeferred(() => execute(doc, name, params, ctx));

type Data = Record<string, unknown>;
type Deviation = { hausdorff: number; mean: number };
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const cageOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
const SPHERE_VOLUME = (4 / 3) * Math.PI * 1000;
const SPHERE_AREA = 4 * Math.PI * 100;

describe('quad_remesh on the native engine (VC-MSH-22, quad part)', () => {
  native('icosphere l4 R10, 600 quads: all quads, eight corners, 15 % of the target, 0.1 mm from the source', async () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const started = performance.now();
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 600 }, context());
    const seconds = (performance.now() - started) / 1000;
    expect(result.error).toBeUndefined();
    const cage = cageOf(result.document, result.affected[0] as string);
    expect(cage.kind).toBe('subdivision');
    expect(cage.faces.every((face) => face.length === 4)).toBe(true);
    expect(cage.creases).toHaveLength(0);
    expect(cage.vertices.length - cage.faces.length).toBe(2);
    const data = dataOf(result);
    expect(data['targetRatio'] as number).toBeGreaterThan(0.85);
    expect(data['targetRatio'] as number).toBeLessThan(1.15);
    const valence = data['valence'] as Record<string, number>;
    // topology consistency, true of any closed genus-0 quad mesh (sum of (4 - valence) = 8, i.e. #3 - #5 = 8): it checks the mesh is a sphere, not its quality
    expect((valence['3'] ?? 0) - (valence['5'] ?? 0)).toBe(8);
    expect(data['irregularVertices'] as number).toBeLessThanOrEqual(12);
    expect(Object.keys(valence).every((key) => ['3', '4', '5'].includes(key))).toBe(true);
    const deviation = data['deviation'] as Deviation;
    expect(deviation.hausdorff).toBeLessThan(0.1);
    expect(deviation.mean).toBeLessThan(0.05);
    expect(seconds).toBeLessThan(10);
    expect(data['provenance']).toMatchObject({ engine: 'native', deterministic: true });
    expect(String((data['provenance'] as { version: string }).version)).toContain('QuadriFlow@');
  });

  // The exact histogram is a property of the reference build only: floating-point code generation differs between compilers and CPUs.
  const reference = BINARY !== null && process.platform === 'win32' && process.arch === 'x64' ? it : it.skip;
  reference('reference build (win32-x64, MSVC): the l4 icosphere at 600 quads has valence {3: 8, 4: 608}', async () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 600 }, context());
    expect(dataOf(result)['quads']).toBe(614);
    expect(dataOf(result)['valence']).toEqual({ '3': 8, '4': 608 });
  });

  native('adaptiveSize on (graded quads) passes the on-source check and stays a closed all-quad sphere', async () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 5));
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 600, adaptiveSize: 50 }, context());
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    const valence = data['valence'] as Record<string, number>;
    expect((valence['3'] ?? 0) - (valence['5'] ?? 0)).toBe(8);
    expect((data['deviation'] as Deviation).hausdorff).toBeLessThan(0.15);
  });

  native('the same input and parameters give the same cage (replay)', async () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 3));
    const run = async (): Promise<string> =>
      JSON.stringify((await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 300 }, context())).document);
    expect(await run()).toBe(await run());
  });

  native('targetEdgeLength: 1.5 mm on R10 asks for area / 1.5^2 quads', async () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetEdgeLength: 1.5, output: 'mesh' }, context());
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect(data['targetQuads']).toBe(Math.round((data['areaBefore'] as number) / 2.25));
    expect(data['targetRatio'] as number).toBeGreaterThan(0.85);
    expect(data['targetRatio'] as number).toBeLessThan(1.15);
  });

  native('output mesh: a closed triangle mesh of the quads, within 0.1 mm of the source', async () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 600, output: 'mesh' }, context());
    const mesh = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(mesh.mesh.indices.length / 3).toBe(2 * (dataOf(result)['quads'] as number));
    const analysis = execute(result.document, 'analyze_mesh', { id: mesh.id, selfIntersections: false });
    expect(dataOf(analysis)).toMatchObject({ closed: true, orientationConsistent: true });
    expect(Math.abs((dataOf(analysis)['volume'] as number) / SPHERE_VOLUME - 1)).toBeLessThan(0.02);
    expect((dataOf(result)['deviation'] as Deviation).hausdorff).toBeLessThan(0.1);
  });

  native('a box: hard edges become the 12 x n creases and the cage keeps the volume', async () => {
    const { doc, ids } = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 300, output: 'mesh' }, context());
    expect(result.error).toBeUndefined();
    const analysis = execute(result.document, 'analyze_mesh', { id: result.affected[0] as string, selfIntersections: false });
    expect(Math.abs((dataOf(analysis)['volume'] as number) / 1000 - 1)).toBeLessThan(0.005);
    const cage = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 300 }, context());
    const creases = cageOf(cage.document, cage.affected[0] as string).creases;
    expect(creases.length).toBeGreaterThanOrEqual(12 * 3);
    expect(dataOf(cage)['creases']).toBe(creases.length);
    const smooth = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 300, detectHardEdgesDeg: 0 }, context());
    expect(cageOf(smooth.document, smooth.affected[0] as string).creases).toHaveLength(0);
  });

  native('a finely tessellated box (20 x 20 per face) gets the same 12 x n creases as the 12-triangle box', async () => {
    const coarse = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
    const fine = docWithMeshes(tessellatedBox(5, 20));
    const creasesOf = async (setup: { doc: CadDocument; ids: string[] }): Promise<number> => {
      const result = await exec(setup.doc, 'quad_remesh', { id: setup.ids[0] as string, targetQuadCount: 300 }, context());
      expect(result.error).toBeUndefined();
      return cageOf(result.document, result.affected[0] as string).creases.length;
    };
    const [coarseCreases, fineCreases] = [await creasesOf(coarse), await creasesOf(fine)];
    expect(coarseCreases).toBeGreaterThanOrEqual(12 * 3);
    expect(fineCreases).toBe(coarseCreases);
  });

  native('two disjoint spheres, the second one inside out: two shells, both outward in the result', async () => {
    const first = icosphere(5, 3, [0, 0, 0]);
    const second = icosphere(5, 3, [20, 0, 0]);
    const reversed = second.indices.flatMap((_, i, all) => (i % 3 === 0 ? [all[i], all[i + 2], all[i + 1]] : []));
    const offset = first.positions.length / 3;
    const mesh = {
      positions: [...first.positions, ...second.positions],
      indices: [...first.indices, ...reversed.map((i) => (i as number) + offset)],
    };
    const { doc, ids } = docWithMeshes(mesh);
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 200, output: 'mesh' }, context());
    expect(result.error, result.summary).toBeUndefined();
    const analysis = dataOf(execute(result.document, 'analyze_mesh', { id: result.affected[0] as string, selfIntersections: false }));
    expect(analysis).toMatchObject({ closed: true, shellCount: 2 });
    expect(Math.abs((analysis['volume'] as number) / (2 * (4 / 3) * Math.PI * 125) - 1)).toBeLessThan(0.1);
    const valence = dataOf(result)['valence'] as Record<string, number>;
    expect(valence['3'] ?? 0).toBeGreaterThanOrEqual(16);
  });

  native('a torus (genus 1) gives vertices = quads (Euler characteristic 0) and no crease on a smooth surface', async () => {
    const { doc, ids } = docWithMeshes(torus(10, 3, 48, 24));
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 400 }, context());
    expect(result.error).toBeUndefined();
    const cage = cageOf(result.document, result.affected[0] as string);
    expect(cage.vertices.length).toBe(cage.faces.length);
    expect(cage.creases).toHaveLength(0);
  });

  native('refuses what QuadriFlow cannot take, with the engine codes and the document untouched', async () => {
    const flipped = icosphere(10, 3);
    [flipped.indices[0], flipped.indices[1]] = [flipped.indices[1] as number, flipped.indices[0] as number];
    const { doc, ids } = docWithMeshes(flipped);
    const refused = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 100 }, context());
    expect(refused.affected).toHaveLength(0);
    expect(refused.document).toBe(doc);
    expect(refused.error?.code).toBe('MESH_ORIENTATION_INCONSISTENT');
  });

  native('LLULL_MESH_OP_TIMEOUT_S caps the job: MESH_TIMEOUT, document untouched', async () => {
    _clearResultCache(); // an earlier test made the same job: its kept result would answer before the timeout
    const impatient = createNativeMeshEngine({ binary: BINARY as string, env: { ...process.env, LLULL_MESH_OP_TIMEOUT_S: '0.001' } });
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const result = await exec(
      doc,
      'quad_remesh',
      { id: ids[0] as string, targetQuadCount: 600 },
      { ...defaultContext(), meshProcessing: impatient },
    );
    expect(result.document).toBe(doc);
    expect(result.error?.code).toBe('MESH_TIMEOUT');
  });

  native(
    'a mesh too small for the target (a tetrahedron asked for 6 quads) is a clean MESH_QUAD_REMESH_FAILED with a reason, never a dead job',
    async () => {
      const tetrahedron = { positions: [1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };
      const { doc, ids } = docWithMeshes(tetrahedron);
      const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 6 }, context());
      expect(result.document).toBe(doc);
      expect(result.error?.code).toBe('MESH_QUAD_REMESH_FAILED');
      // The same four triangles reach the engine renumbered (the host welds into first-use vertex order and winds outward). The Rust call with the raw
      // numbering fails with 'extracted no quad' under both windings (cargo test), so the numbering decides: here QuadriFlow returns 3 faces and the
      // closed-cage validation refuses them.
      expect(result.summary).toMatch(/no quad|closed cage needs at least 4 faces/);
    },
  );
});

describeNative('quad_remesh cage on the native OCC kernel (VC-MSH-22, B-spline part)', () => {
  const kernels = liveKernels();

  native('the cage of the l4 icosphere becomes one bicubic B-spline face per refined quad, a closed solid near the sphere', async () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const result = await exec(doc, 'quad_remesh', { id: ids[0] as string, targetQuadCount: 600 }, context());
    const id = result.affected[0] as string;
    const cage = cageOf(result.document, id);
    const shape = kernels.occt.evaluate(leaf(cage as Entity));
    expect(shape).not.toBeNull();
    const topology = kernels.occt.topology(shape as NonNullable<typeof shape>);
    expect(topology).not.toBeNull();
    expect(topology?.solids).toBe(1);
    expect(topology?.faces).toHaveLength(subdivisionPatches(cage).length);
    expect(topology?.faces).toHaveLength(cage.faces.length * 4 ** (cage.levels - 1));
    expect(topology?.faces.every((face) => face.surface === 'bspline')).toBe(true);
    setGeometryKernel(kernels.occt);
    try {
      const mass = dataOf(execute(result.document, 'mass_properties', { entityId: id, surfaceModel: 'limit_patches' }));
      expect(mass).toMatchObject({ method: 'exact', surfaceModel: 'limit_patches' });
      // the Catmull-Clark limit of a cage on the sphere lies inside it (about -2 % volume, -1.5 % area); fit_subdivision_to_mesh closes the gap
      expect(Math.abs((mass['volume'] as number) / SPHERE_VOLUME - 1)).toBeLessThan(0.04);
      expect(Math.abs((mass['area'] as number) / SPHERE_AREA - 1)).toBeLessThan(0.03);
    } finally {
      setGeometryKernel(null);
    }
  });
});

describe('quad_remesh needs one native job round (TECHNICAL_SPEC 13.9)', () => {
  native(
    'the deviation comes with the quad job: two runs, one job, no separate deviation, and the number the separate measure gives',
    async () => {
      _clearResultCache(); // an earlier test may hold this very job
      const { doc, ids } = docWithMeshes(icosphere(10, 4));
      const asked: Record<string, number> = {};
      const deferred: Record<string, number> = {};
      const counting: MeshProcessingEngine = {
        ...(engine as MeshProcessingEngine),
        run(input, op) {
          asked[op.op] = (asked[op.op] ?? 0) + 1;
          const answer = (engine as MeshProcessingEngine).run(input, op);
          if ('code' in answer && answer.code === MESH_ENGINE_PENDING) deferred[op.op] = (deferred[op.op] ?? 0) + 1;
          return answer;
        },
      };
      let runs = 0;
      const result = await resolveDeferred(() => {
        runs += 1;
        return execute(
          doc,
          'quad_remesh',
          { id: ids[0] as string, targetQuadCount: 600, output: 'mesh' },
          { ...context(), meshProcessing: counting },
        );
      });
      expect(result.error).toBeUndefined();
      expect(runs).toBe(2);
      expect(deferred).toEqual({ quad_remesh: 1 });
      expect(asked['deviation']).toBeUndefined();
      const reported = dataOf(result)['deviation'] as Deviation & Record<string, number>;
      const separate = dataOf(
        execute(result.document, 'measure_deviation', { id: result.affected[0] as string, referenceId: ids[0] as string, symmetric: true }),
      );
      // the maxima do not depend on the order of the samples; the sums differ in the last digits when the mesh is welded again
      for (const key of ['forwardMax', 'backwardMax', 'hausdorff', 'samples'] as const) expect(reported[key]).toBe(separate[key]);
      expect(Math.abs((reported.mean as number) / (separate['mean'] as number) - 1)).toBeLessThan(1e-9);
      expect(Math.abs((reported['rms'] as number) / (separate['rms'] as number) - 1)).toBeLessThan(1e-9);
    },
  );
});

describe('the deviation measured inside the quad job is the one the TypeScript path measures (Rust twins of outwardQuads and triangulateQuads)', () => {
  const twoShells = (): { positions: number[]; indices: number[] } => {
    const first = icosphere(5, 3, [0, 0, 0]);
    const second = icosphere(5, 3, [20, 0, 0]);
    const reversed = second.indices.flatMap((_, i, all) => (i % 3 === 0 ? [all[i], all[i + 2], all[i + 1]] : []));
    const offset = first.positions.length / 3;
    return {
      positions: [...first.positions, ...second.positions],
      indices: [...first.indices, ...reversed.map((i) => (i as number) + offset)],
    };
  };
  const cases: Array<[string, () => { positions: number[]; indices: number[] }, number]> = [
    ['an icosphere', () => icosphere(10, 4), 600],
    ['a box (square quads: ties between the two diagonals)', () => cuboid([-5, -5, -5], [5, 5, 5]), 300],
    ['two shells, the second inside out', twoShells, 200],
  ];

  native.each(cases)(
    '%s: the in-job deviation equals engineDeviation on the outward triangulated quads, also from the reversed quads',
    async (_name, mesh, target) => {
      _clearResultCache();
      const { doc, ids } = docWithMeshes(mesh());
      let input: MeshData | undefined;
      let answer: MeshOpResult | undefined;
      const spy: MeshProcessingEngine = {
        ...(engine as MeshProcessingEngine),
        run(given, op) {
          const result = (engine as MeshProcessingEngine).run(given, op);
          if (op.op === 'quad_remesh' && !('code' in result)) {
            input = given.mesh;
            answer = result;
          }
          return result;
        },
      };
      const result = await resolveDeferred(() =>
        execute(
          doc,
          'quad_remesh',
          { id: ids[0] as string, targetQuadCount: target, output: 'mesh' },
          { ...context(), meshProcessing: spy },
        ),
      );
      expect(result.error, result.summary).toBeUndefined();
      const quads = answer?.quads;
      expect(quads).toBeDefined();
      expect(answer?.deviation).toBeDefined();
      const { positions, quads: raw } = quads as NonNullable<typeof quads>;
      const reversed = raw.flatMap((_, i, all) => (i % 4 === 0 ? [all[i], all[i + 3], all[i + 2], all[i + 1]] : []));
      for (const given of [raw, reversed as number[]]) {
        const triangles = { positions, indices: triangulateQuads(positions, outwardQuads(positions, given)) };
        const expected = engineDeviation(resolveMeshEngine(null), input as MeshData, triangles);
        expect(expected).toEqual(answer?.deviation);
      }
    },
    120_000,
  );
});
