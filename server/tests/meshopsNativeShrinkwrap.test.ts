/**
 * DES-7c native twins (TECHNICAL_SPEC 13.20): the native `shrinkwrap` of `llull-compute meshops` against the TypeScript engine, which is the oracle. Result meshes must hash alike
 * (positions and indices, byte for byte), reports must be equal, for the three modes, both offsets sides, `maxDistance`, open and damaged sources and targets; what the job does not
 * take falls through to the TypeScript engine, and what neither takes is refused by name. Native runs need llull-compute (cargo build in solver/) and are skipped otherwise.
 */

import { describe, expect, it } from 'vitest';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshOp, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import type { MeshData } from '@core/model/types';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { grid, hashOf, icosphere, noisy, withHoles } from './meshopsNativeSupport';
import { soupOf } from './meshopsRepairSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshopsNativeShrinkwrap: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });
const nativeEngine = (): NonNullable<typeof engine> => engine as NonNullable<typeof engine>;

type WrapOp = Extract<MeshOp, { op: 'shrinkwrap' }>;
const wrap = (target: MeshData, extra: Partial<WrapOp> = {}): WrapOp => ({
  op: 'shrinkwrap',
  target: { mesh: target },
  mode: 'nearest',
  offset: 0,
  side: 'keep',
  ...extra,
});

const scaled = (mesh: MeshData, factor: number): MeshData => ({ positions: mesh.positions.map((v) => v * factor), indices: mesh.indices });

/** Both engines on `op`: identical bytes and report. Returns the native answer. */
async function expectSame(mesh: MeshData, op: MeshOp, label = ''): Promise<MeshOpResult> {
  _clearResultCache();
  const ts = tsMeshEngine.run({ mesh }, op);
  const nat = await resolveDeferred(() => nativeEngine().run({ mesh }, op));
  if (isEngineFailure(ts)) throw new Error(`${label} ts: ${ts.code} ${ts.message}`);
  if (isEngineFailure(nat)) throw new Error(`${label} native: ${nat.code} ${nat.message}`);
  expect(hashOf(nat.mesh as MeshData), label).toBe(hashOf(ts.mesh as MeshData));
  expect(nat.report, label).toEqual(ts.report);
  expect(nat.provenance).toMatchObject({
    engine: 'native',
    deterministic: true,
    algorithm: ts.provenance.algorithm,
    reference: ts.provenance.reference,
  });
  return nat;
}

describe('native shrinkwrap is bit-identical to the TypeScript engine (13.20)', () => {
  const target = noisy(icosphere(10, 5), 0.03);
  const outer = noisy(icosphere(12, 4), 0.05);
  const inner = noisy(icosphere(8, 4), 0.05);

  native('nearest: onto a noisy sphere from outside and from inside, with every offset and side', async () => {
    for (const mesh of [outer, inner]) {
      for (const side of ['keep', 'outside', 'inside'] as const) {
        for (const offset of [0, 0.35]) {
          const answer = await expectSame(mesh, wrap(target, { offset, side }), `nearest ${side} ${offset}`);
          expect(answer.report['missed']).toBe(0);
          expect(answer.report['moved'] as number).toBeGreaterThan(1000);
        }
      }
    }
  });

  native('normal: along the vertex normals, both ways (a source inside and outside the target), with a reach', async () => {
    for (const mesh of [outer, inner]) {
      await expectSame(mesh, wrap(target, { mode: 'normal' }), 'normal');
      await expectSame(mesh, wrap(target, { mode: 'normal', offset: 0.2, side: 'outside' }), 'normal outside');
    }
    const reach = await expectSame(
      noisy(icosphere(10, 4), 0.8),
      wrap(target, { mode: 'normal', maxDistance: 0.4, offset: 0.1 }),
      'normal reach',
    );
    expect(reach.report['missed'] as number).toBeGreaterThan(0);
    expect(reach.report['moved'] as number).toBeGreaterThan(0);
  });

  native('direction: a fixed oblique direction, hits and misses, an open grid target and a missing direction', async () => {
    const plate = grid(20, 30, (x, y) => 0.4 * Math.sin(x / 3) * Math.cos(y / 4));
    const holey = withHoles(plate, 5);
    const moved = await expectSame(outer, wrap(plate, { mode: 'direction', direction: [0.3, 0.2, -1] }), 'direction onto a plate');
    expect(moved.report['missed'] as number).toBeGreaterThan(0);
    await expectSame(
      scaled(plate, 0.5),
      wrap(holey, { mode: 'direction', direction: [0, 0.2, 1], offset: 0.25, side: 'outside' }),
      'plate onto holes',
    );
    await expectSame(outer, wrap(target, { mode: 'direction', direction: [1, 1, 1], maxDistance: 5 }), 'direction reach');
    const none = await expectSame(outer, wrap(target, { mode: 'direction' }), 'no direction');
    expect(none.report['moved']).toBe(0);
  });

  native('damaged inputs: a soup with duplicate vertices and degenerate triangles, an open target, an unreferenced vertex', async () => {
    const soup = soupOf(noisy(icosphere(10, 3), 0.1), 0, 1);
    const degenerate = {
      positions: [...soup.positions, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      indices: [...soup.indices, soup.positions.length / 3, soup.positions.length / 3 + 1, soup.positions.length / 3 + 2],
    };
    const unreferenced = { positions: [...soup.positions, 3, 3, 3], indices: soup.indices };
    for (const mode of ['nearest', 'normal'] as const) {
      await expectSame(degenerate, wrap(target, { mode }), `degenerate ${mode}`);
      const answer = await expectSame(unreferenced, wrap(target, { mode }), `unreferenced ${mode}`);
      if (mode === 'normal') expect(answer.report['missed'] as number).toBeGreaterThanOrEqual(1);
    }
    await expectSame(outer, wrap(withHoles(target, 8)), 'target with holes');
  });

  native('a target past the native cap is refused by name before any job is packed', () => {
    const big: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(3 * 4_000_001).fill(0) };
    expect(nativeEngine().run({ mesh: outer }, wrap(big))).toMatchObject({
      code: 'MESH_ENGINE_CAP_EXCEEDED',
      message: expect.stringContaining('4000000'),
    });
  });

  native('what the job does not take goes to the TypeScript engine; what neither takes is refused by name', async () => {
    const composed = composeMeshEngines([nativeEngine(), tsMeshEngine]);
    const run = async (mesh: MeshData, op: MeshOp): Promise<MeshOpResult | MeshEngineFailure> => {
      _clearResultCache();
      return resolveDeferred(() => composed.run({ mesh }, op));
    };
    // a negative offset is outside the job: the TypeScript engine answers it, with its own bytes
    const negative = await run(outer, wrap(target, { offset: -0.2, side: 'outside' }));
    const oracle = tsMeshEngine.run({ mesh: outer }, wrap(target, { offset: -0.2, side: 'outside' })) as MeshOpResult;
    expect(isEngineFailure(negative)).toBe(false);
    expect(hashOf((negative as MeshOpResult).mesh as MeshData)).toBe(hashOf(oracle.mesh as MeshData));
    // coordinates beyond 1e100 are outside the job too
    const huge = scaled(outer, 1e99);
    const far = await run(huge, wrap(scaled(target, 1e99)));
    expect(isEngineFailure(far) ? far.code : 'ok').toBe('ok');
    expect((far as MeshOpResult).provenance.engine).toBe('ts');
    // a target without triangles has no surface
    const empty = await run(outer, wrap({ positions: [], indices: [] }));
    expect(empty).toMatchObject({ code: 'MESH_NOT_A_MESH' });
  });
});
