/**
 * The native engine does not trust a result file (DES-7c step 7): a job that answers with a mesh whose indices point past its vertices, whose indices are not
 * whole triangles, whose positions are not whole triples or whose coordinate is not a number is refused by name, never handed to a command. The same for the
 * report of `repair`, `fill_holes` and `sculpt`, which the commands read field by field. The job is a
 * stand-in (`fixtures/fakeMeshopsJob.cjs`, node preloaded in place of `llull-compute`), so this runs without the Rust binary.
 */

import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MeshOp } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { createNativeMeshEngine, meshProblem } from '../src/native/meshProcessingEngine';

// NODE_OPTIONS reads a backslash as an escape: forward slashes
const FAKE = path.join(__dirname, 'fixtures', 'fakeMeshopsJob.cjs').replaceAll(path.sep, '/');
const sphere = icosphere(10, 2);
const ops: ReadonlyArray<[string, MeshOp]> = [
  ['decimate', { op: 'decimate', preserveBoundary: true, targetTriangles: 100 }],
  ['remesh', { op: 'remesh', targetEdge: 1, iterations: 1, featureAngleRad: 0.7, preserveBoundary: true, project: true }],
  ['repair', { op: 'repair', mode: 'weld', weldTolerance: 1e-6, maxGap: 1e-4, maxBoundaryEdges: 100 }],
  ['fill_holes', { op: 'fill_holes', select: 'all', maxBoundaryEdges: 100, fairing: 'curvature', refine: true }],
  [
    'sculpt',
    {
      op: 'sculpt',
      brush: 'draw',
      stamps: [[0, 0, 10]],
      radius: 3,
      strength: 0.5,
      falloff: 'smooth',
      direction: 'area_normal',
      taubin: false,
    },
  ],
];

const fakeEngine = (mode: string): NonNullable<ReturnType<typeof createNativeMeshEngine>> =>
  createNativeMeshEngine({
    binary: process.execPath,
    env: { ...process.env, NODE_OPTIONS: `--require "${FAKE}"`, FAKE_MESHOPS_RESULT: mode },
  }) as NonNullable<ReturnType<typeof createNativeMeshEngine>>;

describe('a result the host cannot trust', () => {
  // a finished result is kept by the content of its job, whatever the binary: each case needs its own answer
  beforeEach(() => _clearResultCache());

  it.each(ops)('%s: a well-formed answer of the stand-in is accepted (the control of the cases below)', async (_name, op) => {
    const engine = fakeEngine('ok');
    const result = await resolveDeferred(() => engine.run({ mesh: sphere }, op));
    expect(isEngineFailure(result), JSON.stringify(result).slice(0, 200)).toBe(false);
  });

  it.each(
    ops.flatMap(([name, op]) => ['past_vertices', 'odd_indices', 'partial_positions', 'nan'].map((mode) => [name, mode, op] as const)),
  )('%s with %s is refused by name', async (_name, mode, op) => {
    const engine = fakeEngine(mode);
    const result = await resolveDeferred(() => engine.run({ mesh: sphere }, op));
    expect(result).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('the result mesh is malformed') });
  });
});

describe('a report the host cannot trust (repair, fill_holes and sculpt)', () => {
  beforeEach(() => _clearResultCache());
  const reported = ops.filter(([name]) => name === 'repair' || name === 'fill_holes' || name === 'sculpt');

  it.each(reported)('%s: an empty report is refused by name', async (_name, op) => {
    const engine = fakeEngine('bad_report');
    const result = await resolveDeferred(() => engine.run({ mesh: sphere }, op));
    expect(result).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('malformed report') });
  });

  it.each(reported)(
    '%s: a well-formed report for another mode or fairing, or naming a loop past totalLoops, is refused by name',
    async (_name, op) => {
      const engine = fakeEngine('other_report');
      const result = await resolveDeferred(() => engine.run({ mesh: sphere }, op));
      expect(result).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('malformed report') });
    },
  );

  it('fill_holes: a MESH_HOLE_ code that fill_mesh_holes does not document is not handed to the command', async () => {
    const engine = fakeEngine('hole_code');
    const result = await resolveDeferred(() => engine.run({ mesh: sphere }, ops[3]?.[1] as MeshOp));
    expect(result).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('MESH_HOLE_UNDOCUMENTED') });
  });

  it('sculpt: a report that claims a symmetry error without a symmetry plane, or too many stamps applied, is refused (the checks take the op)', async () => {
    const op = ops[4]?.[1] as MeshOp;
    const mirrored = { ...op, symmetry: 'yz' } as MeshOp;
    const engine = fakeEngine('other_report');
    // 3 x the stamps applied is past the 2 x of a mirrored stroke too, and a symmetry error with a plane is fine
    for (const asked of [op, mirrored])
      expect(await resolveDeferred(() => engine.run({ mesh: sphere }, asked))).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED' });
    _clearResultCache();
    expect(isEngineFailure(await resolveDeferred(() => fakeEngine('ok').run({ mesh: sphere }, mirrored)))).toBe(false);
  });

  it('sculpt: a stamp index the op does not have is not handed to the command', async () => {
    const result = await resolveDeferred(() => fakeEngine('sculpt_index').run({ mesh: sphere }, ops[4]?.[1] as MeshOp));
    expect(result).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('SCULPT_OFF_SURFACE') });
  });

  it('sculpt: a blank stamp index is no stamp, and a report moving more vertices than the result has is refused', async () => {
    const op = ops[4]?.[1] as MeshOp;
    const blank = await resolveDeferred(() => fakeEngine('sculpt_blank_index').run({ mesh: sphere }, op));
    expect(blank).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('SCULPT_OFF_SURFACE') });
    _clearResultCache();
    const moved = await resolveDeferred(() => fakeEngine('sculpt_moved').run({ mesh: sphere }, op));
    expect(moved).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED', message: expect.stringContaining('malformed report') });
  });

  it.each(ops.filter(([name]) => name === 'decimate' || name === 'remesh'))('%s: the report is not checked here', async (_name, op) => {
    const engine = fakeEngine('bad_report');
    const result = await resolveDeferred(() => engine.run({ mesh: sphere }, op));
    expect(isEngineFailure(result)).toBe(false);
  });
});

describe('meshProblem', () => {
  it('names the first defect of a mesh and accepts a sound one', () => {
    expect(meshProblem({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] })).toBeNull();
    expect(meshProblem({ positions: [0, 0, 0, 1], indices: [] })).toContain('whole xyz');
    expect(meshProblem({ positions: [0, 0, 0], indices: [0, 0] })).toContain('whole triangles');
    expect(meshProblem({ positions: [0, 0, Infinity], indices: [0, 0, 0] })).toContain('finite');
    expect(meshProblem({ positions: [0, 0, 0], indices: [0, 0, 1] })).toContain('index 1');
  });
});
