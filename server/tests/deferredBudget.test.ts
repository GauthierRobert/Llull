/**
 * The job budget of one resolve (`maxJobs`, default 256) counts the jobs only the native engine can run. With small meshes preferred for native, a plan of
 * more small steps than the budget used to end in MESH_JOB_LIMIT where the TypeScript engine had taken them in process before: once the budget is spent the
 * native engine hands the ops the TypeScript engine can take back to it. A stand-in job (`fixtures/fakeMeshopsJob.cjs`) keeps the test off the Rust binary.
 */

import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import { type MeshOp, type MeshOpResult, isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';

const FAKE = path.join(__dirname, 'fixtures', 'fakeMeshopsJob.cjs').replaceAll(path.sep, '/');
const native = createNativeMeshEngine({
  binary: process.execPath,
  env: { ...process.env, NODE_OPTIONS: `--require "${FAKE}"`, FAKE_MESHOPS_RESULT: 'ok' },
}) as NonNullable<ReturnType<typeof createNativeMeshEngine>>;
const composite = composeMeshEngines([tsMeshEngine, native]);
/** 1,280 triangles: above the 1,000 from which decimate is asked of the native engine first. */
const sphere = icosphere(10, 3);
const steps = (count: number): MeshOp[] =>
  Array.from({ length: count }, (_, k) => ({ op: 'decimate', preserveBoundary: true, targetTriangles: 600 + k }));

beforeEach(() => _clearResultCache());

describe('a plan of small steps longer than the job budget', () => {
  it('runs every step: the steps past the budget are taken in process by the TypeScript engine', async () => {
    const maxJobs = 3;
    const run = (): Array<ReturnType<typeof composite.run>> => steps(maxJobs + 3).map((op) => composite.run({ mesh: sphere }, op));
    const results = await resolveDeferred(run, { maxJobs });
    expect(results.every((result) => !isEngineFailure(result))).toBe(true);
    const engines = results.map((result) => (result as MeshOpResult).provenance.engine);
    expect(engines.filter((engine) => engine === 'native')).toHaveLength(maxJobs);
    expect(engines.filter((engine) => engine === 'ts')).toHaveLength(3);
  });

  it('still refuses with MESH_JOB_LIMIT when what is left cannot be taken by the TypeScript engine', async () => {
    const quad: MeshOp = { op: 'quad_remesh', targetQuads: 100, adaptive: false };
    const refusals: string[] = [];
    await resolveDeferred(() => composite.run({ mesh: sphere }, quad), {
      maxJobs: 0,
      refuse: (refusal) => {
        refusals.push(refusal.code);
        return composite.run({ mesh: sphere }, quad);
      },
    });
    expect(refusals).toEqual(['MESH_JOB_LIMIT']);
  });

  it('a deviation whose other mesh is over the TypeScript cap still counts against the limit', async () => {
    const big = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(3 * 200_001).fill(0) };
    const deviation: MeshOp = { op: 'deviation', other: { mesh: big }, maxSamples: 100 };
    const refusals: string[] = [];
    await resolveDeferred(() => composite.run({ mesh: icosphere(10, 4) }, deviation), {
      maxJobs: 0,
      refuse: (refusal) => {
        refusals.push(refusal.code);
        return composite.run({ mesh: icosphere(10, 4) }, deviation);
      },
    });
    expect(refusals).toEqual(['MESH_JOB_LIMIT']);
  });
});
