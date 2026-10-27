/**
 * VC-MSH-32 (07 MSH M3, RS1 RS-9): the native mesh engine (`llull-compute meshops`) against the TypeScript engine, which is the oracle.
 * `decimate` and `smooth` run on the pack's inputs (planar grids of VC-MSH-06, the icosphere of VC-MSH-07 / 08) and on feature, boundary,
 * region and cotangent variants; the result meshes must hash alike (positions and indices, byte for byte) and the reports must be equal.
 * Native runs need llull-compute (cargo build in solver/) and are skipped with a logged reason otherwise.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshOp, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import type { MeshData } from '@core/model/types';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { resolveDeferred } from '../src/native/deferredRun';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshopsNative: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });

const PHI = (1 + Math.sqrt(5)) / 2;

function icosphere(radius: number, level: number): MeshData {
  const base: Array<[number, number, number]> = [
    [-1, PHI, 0],
    [1, PHI, 0],
    [-1, -PHI, 0],
    [1, -PHI, 0],
    [0, -1, PHI],
    [0, 1, PHI],
    [0, -1, -PHI],
    [0, 1, -PHI],
    [PHI, 0, -1],
    [PHI, 0, 1],
    [-PHI, 0, -1],
    [-PHI, 0, 1],
  ];
  let faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const onSphere = (v: number[]): number[] => {
    const n = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
    return v.map((x) => (x * radius) / n);
  };
  let positions: number[][] = base.map(onSphere);
  for (let l = 0; l < level; l++) {
    const cache = new Map<string, number>();
    const next = positions.slice();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        const [pa, pb] = [positions[a] as number[], positions[b] as number[]];
        m = next.length;
        next.push(
          onSphere([
            ((pa[0] as number) + (pb[0] as number)) / 2,
            ((pa[1] as number) + (pb[1] as number)) / 2,
            ((pa[2] as number) + (pb[2] as number)) / 2,
          ]),
        );
        cache.set(key, m);
      }
      return m;
    };
    const refined: number[][] = [];
    for (const [a, b, c] of faces as Array<[number, number, number]>) {
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      refined.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    positions = next;
    faces = refined;
  }
  return { positions: positions.flat(), indices: faces.flat() };
}

function grid(size: number, n: number, height: (x: number, y: number) => number): MeshData {
  const h = size / n;
  const positions: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * h, j * h, height(i * h, j * h));
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const indices: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  return { positions, indices };
}

function noisy(mesh: MeshData, amplitude: number): MeshData {
  let state = 42;
  const random = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return { positions: mesh.positions.map((v) => v + (random() * 2 - 1) * amplitude), indices: mesh.indices };
}

const hashOf = (mesh: MeshData): string =>
  createHash('sha256')
    .update(Buffer.from(Float64Array.from(mesh.positions).buffer))
    .update(Buffer.from(Uint32Array.from(mesh.indices).buffer))
    .digest('hex');

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
