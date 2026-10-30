/**
 * VC-MSH-32 (07 MSH M3, RS1 RS-9): the native mesh engine (`llull-compute meshops`) against the TypeScript engine, which is the oracle.
 * `decimate` and `smooth` run on the pack's inputs (planar grids of VC-MSH-06, the icosphere of VC-MSH-07 / 08) and on feature, boundary,
 * region and cotangent variants; the result meshes must hash alike (positions and indices, byte for byte) and the reports must be equal.
 * Native runs need llull-compute (cargo build in solver/) and are skipped with a logged reason otherwise.
 */

import { describe, expect, it } from 'vitest';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshOp, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import type { MeshData } from '@core/model/types';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createNativeMeshEngine, deviationFrom } from '../src/native/meshProcessingEngine';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { box, grid, hashOf, icosphere, noisy, withHoles } from './meshopsNativeSupport';
import { soupOf } from './meshopsRepairSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshopsNative: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });

/** The native engine's answer, after the host awaited the job (TECHNICAL_SPEC 13.8). */
const nativeRun = (input: { mesh: MeshData }, op: MeshOp): Promise<MeshOpResult | MeshEngineFailure> =>
  resolveDeferred(() => (engine as NonNullable<typeof engine>).run(input, op));

async function both(mesh: MeshData, op: MeshOp): Promise<{ ts: MeshOpResult; nat: MeshOpResult }> {
  const ts = tsMeshEngine.run({ mesh }, op);
  const nat = await nativeRun({ mesh }, op);
  if (isEngineFailure(ts)) throw new Error(`ts: ${ts.code} ${ts.message}`);
  if (isEngineFailure(nat)) throw new Error(`native: ${nat.code} ${nat.message}`);
  return { ts, nat };
}

async function expectIdentical(mesh: MeshData, op: MeshOp): Promise<{ ts: MeshOpResult; nat: MeshOpResult }> {
  const result = await both(mesh, op);
  expect(hashOf(result.nat.mesh as MeshData)).toBe(hashOf(result.ts.mesh as MeshData));
  expect(result.nat.report).toEqual(result.ts.report);
  expect(result.nat.provenance).toMatchObject({ engine: 'native', deterministic: true });
  expect(result.ts.provenance.engine).toBe('ts');
  return result;
}

const decimate = (extra: Partial<Extract<MeshOp, { op: 'decimate' }>>): MeshOp => ({ op: 'decimate', preserveBoundary: true, ...extra });
const smooth = (extra: Partial<Extract<MeshOp, { op: 'smooth' }>>): MeshOp => ({
  op: 'smooth',
  method: 'taubin',
  lambda: 0.6307,
  passBand: 0.1,
  iterations: 10,
  weights: 'uniform',
  fixBoundary: true,
  volumeCorrection: false,
  ...extra,
});

describe('native decimate is bit-identical to the TypeScript engine (VC-MSH-32)', () => {
  native('VC-MSH-06 planar grids: flat and tilted, target 40, locked boundary', async () => {
    for (const height of [() => 0, (x: number, y: number) => 0.3 * x + 0.2 * y]) {
      const { nat } = await expectIdentical(grid(10, 12, height), decimate({ targetTriangles: 40 }));
      expect((nat.report as { reachedTarget: boolean }).reachedTarget).toBe(false);
    }
  });

  native('VC-MSH-07 icosphere with a triangle target and with a deviation bound', async () => {
    const sphere = icosphere(10, 3);
    await expectIdentical(sphere, decimate({ targetTriangles: 300 }));
    const bounded = await expectIdentical(icosphere(10, 4), decimate({ maxDeviation: 0.05 }));
    expect((bounded.nat.report as { rejected: { deviation: number } }).rejected.deviation).toBeGreaterThan(0);
  });

  native('feature angle, free boundary and a locked region', async () => {
    const sphere = icosphere(10, 3);
    await expectIdentical(sphere, decimate({ targetTriangles: 200, featureAngleRad: Math.PI / 6 }));
    await expectIdentical(sphere, decimate({ targetTriangles: 200, lockedRegion: { center: [0, 0, 10], radius: 4 } }));
    await expectIdentical(
      grid(10, 12, (x, y) => Math.sin(x / 3) * Math.cos(y / 4)),
      decimate({ targetTriangles: 20, preserveBoundary: false }),
    );
    await expectIdentical(noisy(sphere, 0.05), decimate({ targetTriangles: 400, maxDeviation: 0.2 }));
  });

  native('collapsing everything and a target that exhausts the candidates (the queue is one entry per edge, DES-7c)', async () => {
    const everything = await expectIdentical(icosphere(10, 2), decimate({ preserveBoundary: false }));
    expect((everything.nat.report as { trianglesAfter: number }).trianglesAfter).toBeLessThan(8);
    const noisySphere = noisy(icosphere(10, 4), 0.05);
    const small = await expectIdentical(noisySphere, decimate({ targetTriangles: 12, preserveBoundary: false }));
    const report = small.nat.report as { trianglesAfter: number; rejected: { link: number; foldOver: number } };
    expect(report.rejected.link + report.rejected.foldOver).toBeGreaterThan(0);
    // quality: the one-sided distance to the input stays what the TypeScript engine reports for the same result
    const bounded = await expectIdentical(noisySphere, decimate({ maxDeviation: 0.1 }));
    expect((bounded.nat.report as { trianglesAfter: number }).trianglesAfter).toBeLessThan(5120);
  });

  native(
    'stoppedBy follows the final state: a fan that reaches its target with nothing left to collapse, and one below it (DES-7c)',
    async () => {
      const fan: MeshData = {
        positions: [0, -0.1, 0, 3, -1, 0, 4, 1, 0, 3, 2, 0, -3, 2, 0, -4, 1, 0, 0, 0, 0],
        indices: [0, 1, 2, 0, 2, 3, 0, 3, 6, 0, 6, 4, 0, 4, 5, 0, 5, 1],
      };
      const met = await expectIdentical(fan, decimate({ targetTriangles: 4 }));
      expect(met.nat.report).toMatchObject({ trianglesAfter: 4, reachedTarget: true, stoppedBy: 'target' });
      const quad: MeshData = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3] };
      expect((await expectIdentical(quad, decimate({ targetTriangles: 2 }))).nat.report).toMatchObject({
        collapses: 0,
        stoppedBy: 'target',
      });
      const below = await expectIdentical(fan, decimate({ targetTriangles: 3 }));
      expect(below.nat.report).toMatchObject({ trianglesAfter: 4, reachedTarget: false, stoppedBy: 'exhausted' });
    },
  );

  native(
    'NaN costs (overflowing quadrics) order as +Infinity and overflowing normals refuse the collapse, the same in both engines (DES-7c)',
    async () => {
      for (const scale of [3e153, 1e154, 1e155]) {
        const n = 30;
        const positions: number[] = [];
        for (let j = 0; j <= n; j++)
          for (let i = 0; i <= n; i++)
            positions.push(i * scale, j * scale, (Math.sin(i / 3) * Math.cos(j / 4) * 3 + ((i * 7 + j * 13) % 10) / 10) * scale);
        const id = (i: number, j: number): number => j * (n + 1) + i;
        const indices: number[] = [];
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
        const { ts, nat } = await expectIdentical({ positions, indices }, decimate({ targetTriangles: 300, preserveBoundary: false }));
        expect((nat.mesh as MeshData).positions.every(Number.isFinite)).toBe(true);
        expect((ts.report as { collapses: number }).collapses > 0).toBe(scale < 1e155);
      }
    },
  );

  native('refuses meshes the engine cannot edit, with the TypeScript codes', async () => {
    const open = {
      positions: icosphere(1, 1).positions,
      indices: icosphere(1, 1).indices.map((v, i) => (i === 1 ? (icosphere(1, 1).indices[2] ?? v) : v)),
    };
    const result = await nativeRun({ mesh: open }, decimate({ targetTriangles: 10 }));
    expect(isEngineFailure(result)).toBe(true);
    expect((result as { code: string }).code).toMatch(/MESH_(DEGENERATE|NON_MANIFOLD|ORIENTATION_INCONSISTENT)/);
    expect(await nativeRun({ mesh: open }, { op: 'hull', points: [] })).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED' });
  });
});

describe('native smooth is bit-identical to the TypeScript engine (VC-MSH-32)', () => {
  native('VC-MSH-08 Laplacian and Taubin on the clean icosphere l4, 1 / 10 / 50 iterations', async () => {
    const sphere = icosphere(10, 4);
    for (const iterations of [1, 10, 50]) {
      await expectIdentical(sphere, smooth({ method: 'laplacian', iterations }));
      await expectIdentical(sphere, smooth({ method: 'taubin', iterations }));
    }
  });

  native('volume correction (cbrt), cotangent weights, regions, free and fixed boundaries, noisy input', async () => {
    const sphere = icosphere(10, 4);
    const corrected = await expectIdentical(sphere, smooth({ iterations: 50, volumeCorrection: true }));
    expect((corrected.nat.report as { volumeCorrected: boolean }).volumeCorrected).toBe(true);
    await expectIdentical(noisy(sphere, 0.1), smooth({ iterations: 10, volumeCorrection: true }));
    await expectIdentical(icosphere(10, 3), smooth({ method: 'laplacian', weights: 'cotangent', iterations: 5 }));
    await expectIdentical(icosphere(10, 3), smooth({ weights: 'cotangent', iterations: 5, volumeCorrection: true }));
    await expectIdentical(sphere, smooth({ iterations: 5, region: { center: [0, 0, 10], radius: 3 } }));
    const patch = noisy(
      grid(10, 10, () => 0),
      0.2,
    );
    await expectIdentical(patch, smooth({ iterations: 4 }));
    await expectIdentical(patch, smooth({ iterations: 4, fixBoundary: false, volumeCorrection: true }));
  });
});

const remesh = (extra: Partial<Extract<MeshOp, { op: 'remesh' }>>): MeshOp => ({
  op: 'remesh',
  iterations: 3,
  featureAngleRad: (40 * Math.PI) / 180,
  preserveBoundary: true,
  project: true,
  ...extra,
});

describe('native remesh is bit-identical to the TypeScript engine (VC-MSH-32, DES-7c)', () => {
  native('isotropic: the icosphere to two edge lengths, noisy input, projection off, one and many iterations', async () => {
    const sphere = icosphere(10, 3);
    const split = await expectIdentical(sphere, remesh({ targetEdge: 0.9 }));
    expect((split.nat.report as { splits: number }).splits).toBeGreaterThan(0);
    const merged = await expectIdentical(sphere, remesh({ targetEdge: 3 }));
    expect((merged.nat.report as { collapses: number }).collapses).toBeGreaterThan(0);
    await expectIdentical(noisy(sphere, 0.05), remesh({ targetEdge: 1.2, iterations: 5 }));
    await expectIdentical(sphere, remesh({ targetEdge: 1.2, project: false, iterations: 1 }));
    await expectIdentical(noisy(icosphere(10, 4), 0.02), remesh({ targetEdge: 1, iterations: 4 }));
  });

  native('adaptive: edge length follows the curvature, clamped to the band', async () => {
    const result = await expectIdentical(icosphere(10, 3), remesh({ minEdge: 0.5, maxEdge: 3, approxError: 0.02 }));
    expect((result.nat.report as { mode: string }).mode).toBe('adaptive');
    await expectIdentical(box(10, 6), remesh({ minEdge: 0.8, maxEdge: 4, approxError: 0.05 }));
  });

  native('feature edges of a box, a free boundary, a region and a low feature angle', async () => {
    const cube = box(10, 6);
    const kept = await expectIdentical(cube, remesh({ targetEdge: 2.5 }));
    expect((kept.nat.report as { featureEdges: number }).featureEdges).toBeGreaterThan(0);
    await expectIdentical(cube, remesh({ targetEdge: 1.5, featureAngleRad: (95 * Math.PI) / 180 }));
    await expectIdentical(icosphere(10, 3), remesh({ targetEdge: 0.6, region: { center: [0, 0, 10], radius: 3 } }));
    const patch = grid(10, 8, (x, y) => Math.sin(x / 3) * Math.cos(y / 4));
    await expectIdentical(patch, remesh({ targetEdge: 2 }));
    await expectIdentical(patch, remesh({ targetEdge: 2, preserveBoundary: false }));
  });

  native('the closing passes and the triangle limit refuse alike (MESH_REMESH_RESULT_TOO_LARGE)', async () => {
    const sphere = icosphere(10, 2);
    const limited = remesh({ targetEdge: 0.3, maxTriangles: 3000 });
    const ts = tsMeshEngine.run({ mesh: sphere }, limited);
    const nat = await nativeRun({ mesh: sphere }, limited);
    expect(ts).toMatchObject({ code: 'MESH_REMESH_RESULT_TOO_LARGE' });
    expect(nat).toMatchObject({ code: 'MESH_REMESH_RESULT_TOO_LARGE' });
    expect((nat as MeshEngineFailure).message).toBe((ts as MeshEngineFailure).message);
  });

  native('refuses a mesh it cannot edit and a job without lengths, by name', async () => {
    const open = { positions: icosphere(1, 1).positions, indices: icosphere(1, 1).indices.slice(3) };
    // an open mesh is editable: the same bytes in both engines
    await expectIdentical(open, remesh({ targetEdge: 0.5 }));
    const soup = { positions: icosphere(1, 1).positions, indices: icosphere(1, 1).indices.map((v, i) => (i === 1 ? 0 : v)) };
    const refused = tsMeshEngine.run({ mesh: soup }, remesh({ targetEdge: 0.5 }));
    expect(refused).toMatchObject({ code: expect.stringMatching(/MESH_(DEGENERATE|NON_MANIFOLD)/) });
    expect(await nativeRun({ mesh: soup }, remesh({ targetEdge: 0.5 }))).toEqual(refused);
    const none = await nativeRun({ mesh: icosphere(1, 1) }, remesh({}));
    expect(none).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('targetEdge') });
  });
});

const analyze = (extra: Partial<Extract<MeshOp, { op: 'analyze' }>> = {}): MeshOp => ({
  op: 'analyze',
  weldTolerance: 0,
  selfIntersections: false,
  maxListed: 20,
  ...extra,
});

/** Every field of the analysis and of the report, `+0` and `-0` apart: `toEqual` compares numbers with Object.is. */
async function expectSameAnalysis(mesh: MeshData, op: MeshOp): Promise<MeshOpResult> {
  const ts = tsMeshEngine.run({ mesh }, op);
  const nat = await nativeRun({ mesh }, op);
  if (isEngineFailure(ts) || isEngineFailure(nat))
    throw new Error(`ts: ${JSON.stringify(ts).slice(0, 120)}; native: ${JSON.stringify(nat).slice(0, 120)}`);
  expect(nat.analysis).toEqual(ts.analysis);
  expect(nat.report).toEqual(ts.report);
  expect(nat.provenance).toMatchObject({ engine: 'native', algorithm: ts.provenance.algorithm, reference: ts.provenance.reference });
  return nat;
}

describe('native analyze is bit-identical to the TypeScript engine (VC-MSH-32, DES-7c)', () => {
  const flipped = (mesh: MeshData, every: number): MeshData => ({
    positions: mesh.positions,
    indices: mesh.indices.map((v, i) =>
      i % (every * 3) === 1 ? (mesh.indices[i + 1] as number) : i % (every * 3) === 2 ? (mesh.indices[i - 1] as number) : v,
    ),
  });

  native('closed solids: the icosphere, a box and a noisy sphere, with the list length cut to 0, 1 and 1000', async () => {
    for (const maxListed of [0, 1, 1000]) {
      await expectSameAnalysis(icosphere(10, 3), analyze({ maxListed }));
      await expectSameAnalysis(box(10, 5), analyze({ maxListed }));
    }
    const closed = await expectSameAnalysis(noisy(icosphere(10, 3), 0.2), analyze());
    expect(closed.analysis).toMatchObject({ closed: true, manifold: true, shellCount: 1, genus: 0 });
  });

  native('open, multi-shell, flipped and damaged meshes: boundary loops, shells, orientation, degenerate and duplicate faces', async () => {
    const patch = grid(10, 8, (x, y) => Math.sin(x / 3) * y);
    expect((await expectSameAnalysis(patch, analyze())).analysis).toMatchObject({ closed: false, boundaryLoopCount: 1 });
    const two = icosphere(3, 2);
    const apart: MeshData = {
      positions: [...two.positions, ...two.positions.map((v, i) => (i % 3 === 0 ? v + 10 : v))],
      indices: [...two.indices, ...two.indices.map((v) => v + two.positions.length / 3)],
    };
    expect((await expectSameAnalysis(apart, analyze({ maxListed: 1 }))).analysis).toMatchObject({ shellCount: 2 });
    expect((await expectSameAnalysis(flipped(icosphere(10, 2), 7), analyze())).analysis).toMatchObject({ orientationConsistent: false });
    const sphere = icosphere(10, 2);
    const damaged: MeshData = {
      positions: sphere.positions,
      indices: [...sphere.indices.slice(3), ...sphere.indices.slice(30, 33), 4, 4, 5, ...sphere.indices.slice(60, 63).reverse()],
    };
    const counted = await expectSameAnalysis(damaged, analyze());
    expect(counted.analysis).toMatchObject({ degenerateFaces: 1, closed: false });
    expect((counted.analysis as { duplicateFaces: number }).duplicateFaces).toBeGreaterThan(0);
  });

  native('an unwelded soup is welded first (mergedVertices), and unused vertices are dropped', async () => {
    const sphere = icosphere(10, 2);
    const soup: MeshData = {
      positions: sphere.indices.flatMap((v) => sphere.positions.slice(v * 3, v * 3 + 3)),
      indices: sphere.indices.map((_, i) => i),
    };
    const result = await expectSameAnalysis({ positions: [...soup.positions, 9, 9, 9], indices: soup.indices }, analyze());
    expect(result.report).toEqual({ weldTolerance: 0, mergedVertices: soup.positions.length / 3 - sphere.positions.length / 3 });
    expect(result.analysis).toMatchObject({ vertices: sphere.positions.length / 3, closed: true });
  });

  native('what it does not do is refused by name, so the composite falls back or reports the cap', async () => {
    const sphere = icosphere(10, 2);
    expect(await nativeRun({ mesh: sphere }, analyze({ weldTolerance: 0.1 }))).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED' });
    const composite = composeMeshEngines([tsMeshEngine, engine as NonNullable<typeof engine>]);
    expect(composite.capabilities().get('analyze')).toBe(Infinity);
    expect(composite.capabilities().get('remesh')).toBe(2_000_000);
    const huge = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(2_000_001 * 3).fill(0) };
    expect(composite.run({ mesh: huge }, remesh({ targetEdge: 1 }))).toMatchObject({ code: 'MESH_ENGINE_CAP_EXCEEDED' });
  });
});

describe('native deviation is bit-identical to the TypeScript engine (VC-MSH-25, 32)', () => {
  native('sphere against its decimation, noisy against clean, strided samples, parallel grids', async () => {
    const run = async (a: MeshData, b: MeshData, maxSamples: number): Promise<void> => {
      const op: MeshOp = { op: 'deviation', other: { mesh: b }, maxSamples };
      const ts = tsMeshEngine.run({ mesh: a }, op);
      const nat = await nativeRun({ mesh: a }, op);
      if (isEngineFailure(ts) || isEngineFailure(nat)) throw new Error('deviation failed');
      expect(nat.deviation).toEqual(ts.deviation);
      expect(nat.provenance.engine).toBe('native');
    };
    const sphere = icosphere(10, 4);
    const decimated = tsMeshEngine.run({ mesh: sphere }, decimate({ maxDeviation: 0.05 })) as MeshOpResult;
    await run(sphere, decimated.mesh as MeshData, 20_000);
    await run(sphere, decimated.mesh as MeshData, 500);
    await run(noisy(sphere, 0.1), sphere, 20_000);
    const flat = grid(10, 10, () => 0);
    const lifted = { positions: flat.positions.map((v, i) => (i % 3 === 2 ? v + 0.5 : v)), indices: flat.indices };
    await run(flat, lifted, 20_000);
    const parallel = await nativeRun({ mesh: flat }, { op: 'deviation', other: { mesh: lifted }, maxSamples: 20_000 });
    expect((parallel as MeshOpResult).deviation?.hausdorff).toBe(0.5);
    const empty = await nativeRun({ mesh: flat }, { op: 'deviation', other: { mesh: { positions: [], indices: [] } }, maxSamples: 10 });
    expect(isEngineFailure(empty)).toBe(true);
  });
});

describe('the composite engine routes by cap', () => {
  it('lists the native ops without a cap and falls back to the TypeScript engine when it is absent', () => {
    if (engine === null) return;
    const composite = composeMeshEngines([tsMeshEngine, engine]);
    expect(composite.capabilities().get('decimate')).toBe(Infinity);
    expect(composite.capabilities().get('smooth')).toBe(Infinity);
    expect(composite.capabilities().get('deviation')).toBe(Infinity);
    expect(createNativeMeshEngine({ env: { LLULL_COMPUTE: 'does-not-exist.exe' } })).toBeNull();
  });
});

describe('the composite engine prefers the native one above a per-op size (DES-7c step 7)', () => {
  const composite = (): ReturnType<typeof composeMeshEngines> => composeMeshEngines([tsMeshEngine, engine as NonNullable<typeof engine>]);
  const provenanceOf = (result: MeshOpResult | MeshEngineFailure): string => (result as MeshOpResult).provenance.engine;

  native('decimate: the TypeScript engine below 1,000 triangles, the native one above, the same bytes either way', async () => {
    const op = decimate({ targetTriangles: 100 });
    const small = icosphere(10, 2);
    expect(provenanceOf(composite().run({ mesh: small }, op))).toBe('ts');
    const larger = noisy(icosphere(10, 3), 0.02);
    const routed = await resolveDeferred(() => composite().run({ mesh: larger }, op));
    expect(provenanceOf(routed)).toBe('native');
    const oracle = tsMeshEngine.run({ mesh: larger }, op) as MeshOpResult;
    expect(hashOf((routed as MeshOpResult).mesh as MeshData)).toBe(hashOf(oracle.mesh as MeshData));
    expect((routed as MeshOpResult).report).toEqual(oracle.report);
  });

  native('analyze above 15,000 triangles goes native, below it stays in process', async () => {
    const op = analyze();
    expect(provenanceOf(composite().run({ mesh: icosphere(10, 4) }, op))).toBe('ts');
    const routed = await resolveDeferred(() => composite().run({ mesh: icosphere(10, 5) }, op));
    expect(provenanceOf(routed)).toBe('native');
    expect((routed as MeshOpResult).analysis).toEqual((tsMeshEngine.run({ mesh: icosphere(10, 5) }, op) as MeshOpResult).analysis);
  });

  native(
    'analyze with the pair search goes native above 15,000 triangles too, with the same pairs, and stays in process below',
    async () => {
      const op = analyze({ selfIntersections: true });
      expect(provenanceOf(composite().run({ mesh: icosphere(10, 4) }, op))).toBe('ts');
      const mesh = noisy(icosphere(10, 5), 0.2);
      const routed = await resolveDeferred(() => composite().run({ mesh }, op));
      expect(provenanceOf(routed)).toBe('native');
      expect((routed as MeshOpResult).analysis?.selfIntersectionPairs).toBeGreaterThan(0);
      expect((routed as MeshOpResult).analysis).toEqual((tsMeshEngine.run({ mesh }, op) as MeshOpResult).analysis);
    },
  );

  native('outside the resolving host path the native engine hands over, so the in-process answer still works', () => {
    // a finished job answers without a scope, so start with none kept
    _clearResultCache();
    const answered = composite().run({ mesh: noisy(icosphere(10, 3), 0.02) }, decimate({ targetTriangles: 100 }));
    expect(provenanceOf(answered)).toBe('ts');
    expect(composite().capabilities().get('decimate')).toBe(Infinity);
  });
});

describe('a native job that measures the deviation of its own result (TECHNICAL_SPEC 13.9)', () => {
  const MAX_SAMPLES = 20_000;
  const deviationOp = (other: MeshData): MeshOp => ({ op: 'deviation', other: { mesh: other }, maxSamples: MAX_SAMPLES });

  native.each([
    ['decimate', icosphere(10, 4), decimate({ targetTriangles: 400 })],
    ['smooth', icosphere(10, 3), smooth({ iterations: 5 })],
    // repair measures from the raw input (a soup with unused, duplicate and degenerate corners); fill_holes from the open mesh
    [
      'repair',
      soupOf(withHoles(icosphere(10, 3), 5), 1e-4, 3),
      { op: 'repair', mode: 'close_holes', weldTolerance: 1e-3, maxGap: 0.01, maxBoundaryEdges: 1000 } as MeshOp,
    ],
    [
      'fill_holes',
      withHoles(noisy(icosphere(10, 4), 0.02), 10),
      { op: 'fill_holes', select: 'all', maxBoundaryEdges: 1000, fairing: 'curvature', refine: true } as MeshOp,
    ],
  ] as const)('%s: the deviation in the answer is the one the separate job, and the TypeScript engine, give', async (_name, mesh, op) => {
    const asked = { ...op, withDeviation: MAX_SAMPLES } as MeshOp;
    const answer = await nativeRun({ mesh }, asked);
    if (isEngineFailure(answer)) throw new Error(`${answer.code} ${answer.message}`);
    const result = answer.mesh as MeshData;
    const separate = await nativeRun({ mesh }, deviationOp(result));
    const oracle = tsMeshEngine.run({ mesh }, deviationOp(result));
    if (isEngineFailure(separate) || isEngineFailure(oracle)) throw new Error('the separate deviation failed');
    expect(answer.deviation).toBeDefined();
    expect(answer.deviation).toEqual(separate.deviation);
    expect(answer.deviation).toEqual(oracle.deviation);
    // the result itself and its report are those of the job without the request
    const plain = await nativeRun({ mesh }, op);
    if (isEngineFailure(plain)) throw new Error('the plain job failed');
    expect(hashOf(plain.mesh as MeshData)).toBe(hashOf(result));
    expect(plain.report).toEqual(answer.report);
    expect(plain.deviation).toBeUndefined();
  });

  native('one job round: the request is a single deferral, and asking for the deviation is a different job than not asking', async () => {
    const mesh = icosphere(10, 3);
    const op = { ...decimate({ targetTriangles: 300 }), withDeviation: MAX_SAMPLES } as MeshOp;
    let runs = 0;
    const answer = await resolveDeferred(() => (runs++, (engine as NonNullable<typeof engine>).run({ mesh }, op)));
    expect(isEngineFailure(answer)).toBe(false);
    expect(runs).toBe(2);
  });
});

describe('the deviation a job reports is checked before it is trusted', () => {
  const good = {
    forwardMax: 1,
    backwardMax: 2,
    hausdorff: 2,
    mean: 0.5,
    rms: 0.7,
    samples: 10,
    histogram: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    worst: { point: [0, 1, 2], mesh: 'b', distance: 2 },
  };

  it('keeps a well-formed summary and drops anything else, so the caller measures separately', () => {
    expect(deviationFrom(good)).toEqual({ deviation: good });
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { ...good, mean: null },
      { ...good, hausdorff: 'big' },
      { ...good, histogram: [1, 2] },
      { ...good, histogram: [1, 1, 1, 1, 1, 1, 1, 1, 1, null] },
      { ...good, worst: { point: [0, 1], mesh: 'a', distance: 1 } },
      { ...good, worst: { point: [0, 1, 2], mesh: 'c', distance: 1 } },
      { ...good, worst: null },
    ])
      expect(deviationFrom(bad)).toEqual({});
  });
});
