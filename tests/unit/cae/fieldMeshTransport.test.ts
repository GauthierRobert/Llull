/**
 * The fea_mesh transport of mesh source implicit_field (server/src/fea/fieldMesh.ts) with a scripted llull-compute: what it records, and the
 * host lifecycle (one shared job for identical requests, each caller's own cancellation, the progress bound, refusals that commit nothing).
 * The real binary runs in server/tests/feaFieldMesh.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactStore } from '../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../server/src/fea/caeHooks';
import { runFeaMesh } from '../../../server/src/fea/feaMesh';
import { runFieldMesh } from '../../../server/src/fea/fieldMesh';
import { runConvergenceStudy } from '../../../server/src/fea/feaConvergence';
import type { ComputeRunner, JobRun } from '../../../server/src/native/computeJob';
import { sha256Hex } from '../../../server/src/sha256';
import type { MeshRequest } from '@cae/index';
import { caseIn } from './helpers';
import { implicitAnalysis } from './fieldMeshFixtures';

let directory = '';
let store: FeArtifactStore;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-field-mesh-'));
  store = createFeArtifactStore(directory);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

interface Host extends FeaHost {
  readonly doc: () => CadDocument;
  readonly commands: string[];
}

function hostOf(start: CadDocument, extra: { signal?: AbortSignal; onProgress?: (line: string) => void } = {}): Host {
  let doc = start;
  const commands: string[] = [];
  return {
    getDoc: () => doc,
    doc: () => doc,
    commands,
    applyCommand: (name, params): FeaToolResult => {
      commands.push(name);
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
      if (result.rejected !== true) doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
    },
    ...extra,
  };
}

/** One straight C3D10 (unit corner tetrahedron) and every target of job.json resolved on it. */
function writeMesh(folder: string): JobRun['outputs'] {
  const job = JSON.parse(readFileSync(path.join(folder, 'job.json'), 'utf8')) as { targets: { key: string; global?: boolean }[] };
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const mids = [
    [0, 1],
    [1, 2],
    [2, 0],
    [0, 3],
    [1, 3],
    [2, 3],
  ].map(([a, b]) => [0, 1, 2].map((i) => ((corners[a ?? 0]?.[i] ?? 0) + (corners[b ?? 0]?.[i] ?? 0)) / 2));
  const files: Record<string, Buffer> = {
    'nodes.f64': Buffer.from(Float64Array.from([...corners, ...mids].flat()).buffer),
    'elements.u32': Buffer.from(Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer),
  };
  const sets = Object.fromEntries(
    job.targets.filter((t) => t.global !== true).map((t) => [t.key, { nodes: [0, 1, 2, 4, 5, 6], faces: [[0, 1]], residual: 0 }]),
  );
  const nearest = Object.fromEntries(job.targets.filter((t) => t.global === true).map((t) => [t.key, { node: 3, distance: 0.5 }]));
  const report = {
    nodes: 10,
    elements: 1,
    order: 2,
    volume: 1 / 6,
    quality: { minDihedralDeg: 54.7, maxDihedralDeg: 90, folded: 0, nonManifold: 0, inverted: 0, degenerate: 0, open: 0 },
    sets,
    nearest,
    curvedMidNodes: 0,
    warpedVertices: 0,
    steinerVertices: 0,
    clippedCorners: 0,
  };
  files['report.json'] = Buffer.from(JSON.stringify(report));
  return Object.entries(files).map(([name, bytes]) => {
    writeFileSync(path.join(folder, name), bytes);
    return { path: name, sha256: sha256Hex(bytes) };
  });
}

const done = (outputs: JobRun['outputs']): JobRun => ({ ok: true, outputs, warnings: [], log: '', elapsedMs: 1 });
const failed = (code: string): JobRun => ({ ok: false, outputs: [], code, message: code, warnings: [], log: '', elapsedMs: 1 });

interface Scripted {
  readonly runner: ComputeRunner;
  readonly runs: AbortSignal[];
  release(): void;
}

/** A runner whose job reports progress, then waits for `release()` (or its signal) before writing its outputs. */
function scripted(behaviour: 'mesh' | 'silent' | 'refuse' = 'mesh'): Scripted {
  const runs: AbortSignal[] = [];
  const waiting: (() => void)[] = [];
  const runner: ComputeRunner = {
    binary: 'llull-compute',
    version: () => Promise.resolve('0.1.0'),
    run: (_args, folder, _timeout, onProgress, signal) => {
      runs.push(signal ?? new AbortController().signal);
      if (behaviour !== 'silent') onProgress?.({ type: 'progress', step: 10, total: 100, message: 'lattice' });
      return new Promise<JobRun>((resolve) => {
        const finish = (): void => {
          if (signal?.aborted === true) return;
          if (behaviour === 'refuse') {
            const bytes = Buffer.from(
              JSON.stringify({ refusal: { code: 'FLL_IMPLICIT_MESH_TOO_LARGE', message: '9 lattice vertices exceed 1' } }),
            );
            writeFileSync(path.join(folder, 'report.json'), bytes);
            resolve(done([{ path: 'report.json', sha256: sha256Hex(bytes) }]));
          } else resolve(done(writeMesh(folder)));
        };
        signal?.addEventListener('abort', () => resolve(failed('NATIVE_CANCELLED')), { once: true });
        if (behaviour === 'refuse') finish();
        else waiting.push(finish);
      });
    },
  };
  return { runner, runs, release: () => waiting.splice(0).forEach((finish) => finish()) };
}

const deps = (runner: ComputeRunner, env: NodeJS.ProcessEnv = {}): Parameters<typeof runFieldMesh>[2] => ({
  runner,
  store,
  hooks: caeHooks,
  env,
});

function requestOf(doc: CadDocument, analysisId: string): MeshRequest {
  const request = caeHooks.meshRequest(doc, analysisId);
  if ('code' in request) throw new Error(request.message);
  return request;
}

/** Waits (10 ms steps, up to 5 s) until `ready` holds: job folders are written asynchronously before the runner starts. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('fea_mesh source implicit_field', () => {
  it('meshes through llull-compute field and records the mesh', async () => {
    const { doc, analysisId, bodyId } = implicitAnalysis();
    const job = scripted();
    const host = hostOf(doc);
    const lines: string[] = [];
    const pending = runFeaMesh(analysisId, hostOf(doc, { onProgress: (line) => lines.push(line) }), {
      mesher: () => Promise.reject(new Error('Netgen must not run')),
      store,
      hooks: caeHooks,
      kernel: () => null,
      fieldMesh: (request, fieldHost) => runFieldMesh(request, { ...fieldHost, applyCommand: host.applyCommand }, deps(job.runner)),
    });
    await until(() => job.runs.length === 1);
    job.release();
    const result = await pending;
    expect(result.isError, result.summary).toBe(false);
    expect(result.summary).toContain('from the implicit field (llull-field 0.1.0 (isosurface stuffing)');
    expect(result.data).toMatchObject({ nodes: 10, elements: { C3D10: 1 }, facetedParts: [] });
    expect(lines).toEqual([`fea_mesh ${bodyId}: lattice 10 %`]);
    expect(host.commands).toEqual(['record_fe_mesh']);
    expect(caseIn(host.doc(), analysisId).meshSummary?.mesher).toBe('llull-field');
  });

  it('shares one job between identical requests; a caller that leaves commits nothing and the last one kills the job', async () => {
    const { doc, analysisId } = implicitAnalysis();
    const job = scripted();
    const [first, second, third] = [new AbortController(), new AbortController(), new AbortController()];
    const hosts = [hostOf(doc, { signal: first.signal }), hostOf(doc, { signal: second.signal })];
    const calls = hosts.map((host) => runFieldMesh(requestOf(doc, analysisId), host, deps(job.runner)));
    await until(() => job.runs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(job.runs).toHaveLength(1);
    first.abort();
    const cancelled = await calls[0];
    expect(cancelled?.summary).toContain('FEA_MESH_CANCELLED');
    expect(job.runs[0]?.aborted).toBe(false);
    job.release();
    const finished = await calls[1];
    expect(finished?.isError, finished?.summary).toBe(false);
    expect(hosts[0]?.commands).toEqual([]);
    expect(hosts[0]?.doc()).toBe(doc);
    expect(hosts[1]?.commands).toEqual(['record_fe_mesh']);
    const lone = hostOf(doc, { signal: third.signal });
    const alone = runFieldMesh(requestOf(doc, analysisId), lone, deps(job.runner));
    await until(() => job.runs.length === 2);
    expect(job.runs).toHaveLength(2);
    third.abort();
    expect((await alone).summary).toContain('FEA_MESH_CANCELLED');
    expect(job.runs[1]?.aborted).toBe(true);
    expect(lone.commands).toEqual([]);
  });

  it('stops a job that reports no progress within the stall bound', async () => {
    const { doc, analysisId } = implicitAnalysis();
    const job = scripted('silent');
    const host = hostOf(doc);
    const result = await runFieldMesh(requestOf(doc, analysisId), host, deps(job.runner, { LLULL_FIELD_TETS_STALL_S: '1' }));
    expect(result.summary).toContain('FLL_IMPLICIT_MESH_STALLED');
    expect(job.runs[0]?.aborted).toBe(true);
    expect(host.commands).toEqual([]);
  });

  it('passes a job refusal through by name and records nothing', async () => {
    const { doc, analysisId, bodyId } = implicitAnalysis();
    const host = hostOf(doc);
    const result = await runFieldMesh(requestOf(doc, analysisId), host, deps(scripted('refuse').runner));
    expect(result).toMatchObject({ isError: true, affected: [analysisId, bodyId] });
    expect(result.summary).toContain('FLL_IMPLICIT_MESH_TOO_LARGE');
    expect(host.commands).toEqual([]);
  });

  it('refuses a part that is not an implicit body, and a host without llull-compute, before any job', async () => {
    const { doc, analysisId } = implicitAnalysis();
    const boxed = execute(doc, 'add_box', { size: [1, 1, 1] });
    const boxId = boxed.affected[0] ?? '';
    const withBox = execute(boxed.document, 'set_part_idealization', { analysisId, entityId: boxId, idealization: 'solid' }).document;
    const job = scripted();
    const notBody = await runFieldMesh(requestOf(withBox, analysisId), hostOf(withBox), deps(job.runner));
    expect(notBody.summary).toContain('FLL_IMPLICIT_FIELD_MISSING');
    expect(job.runs).toHaveLength(0);
    const missing = await runFieldMesh(requestOf(doc, analysisId), hostOf(doc), deps({ ...job.runner, binary: null }));
    expect(missing.summary).toContain('NATIVE_TOOL_MISSING');
    const noTransport = await runFeaMesh(analysisId, hostOf(doc), {
      mesher: () => Promise.reject(new Error('no')),
      store,
      hooks: caeHooks,
      kernel: () => null,
    });
    expect(noTransport.summary).toContain('NATIVE_TOOL_MISSING');
  });
});

describe('run_convergence_study on a field-meshed case', () => {
  it('passes the caller signal to every level: cancelling stops the level job and records nothing', async () => {
    const { doc, analysisId } = implicitAnalysis();
    const probeId = Object.keys(caseIn(doc, analysisId).probes ?? {})[0] ?? '';
    const job = scripted();
    const cancel = new AbortController();
    const host = hostOf(doc, { signal: cancel.signal });
    const study = runConvergenceStudy(analysisId, { quantity: { kind: 'probe', probeId, loadCase: 'LC1' }, levels: 3 }, host, {
      store,
      hooks: caeHooks,
      mesh: (id, levelHost) =>
        runFeaMesh(id, levelHost, {
          mesher: () => Promise.reject(new Error('Netgen must not run')),
          store,
          hooks: caeHooks,
          kernel: () => null,
          fieldMesh: (request, fieldHost) => runFieldMesh(request, fieldHost, deps(job.runner)),
        }),
      solve: () =>
        Promise.resolve({
          summary: 'fea_solve NOT_REACHED: the level must stop at meshing',
          affected: [],
          isError: true,
          data: { code: 'NOT_REACHED' },
        }),
    });
    await until(() => job.runs.length === 1);
    cancel.abort();
    // a level host without the caller's signal would keep waiting: release the job so that case ends (and fails the assertions below)
    const fallback = setTimeout(() => job.release(), 200);
    const result = await study;
    clearTimeout(fallback);
    expect(result.summary).toContain('VNV_LEVEL_FAILED');
    expect(result.data).toMatchObject({ stage: 'meshing', cause: 'FEA_MESH_CANCELLED' });
    expect(job.runs[0]?.aborted).toBe(true);
    expect(host.commands).toEqual([]);
    expect(host.doc()).toBe(doc);
  });
});
