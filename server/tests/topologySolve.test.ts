/**
 * topology_solve transport (PHY-17 RS-2) with an injected fake job runner (no binary): job folder contents and index mapping, artifact + record, the
 * TypeScript reference without llull-compute, TOP_TOOL_MISSING above the cap, native error / timeout mapping, resume. The real binary is
 * `topologySolveNative.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildExchangeRouter } from '../src/exchangeRoutes';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { FeTopologyArtifact } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { toolsetOf } from '@protocol/toolsets';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import type { ComputeRunner, JobRun } from '../src/native/computeJob';
import { exchangeTool } from '../src/cli/exchange';
import { runTopologySolve } from '../src/native/topologySolve';
import { runNativeTool } from '../src/native/tools';
import { mbbModel, studyOf, type Model } from '../../tests/unit/cae/topology/support';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-topology-store-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A host over a mutable document: `record_topology_result` replaces it, like the CLI's local backend. */
function hostOf(model: Model): FeaHost & { current(): CadDocument } {
  let doc = model.doc;
  return {
    current: () => doc,
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
      if (result.rejected !== true) doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
}

interface Call {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly files: Readonly<Record<string, Buffer>>;
}

interface FakeOptions {
  readonly fail?: { readonly code: string; readonly message: string };
  readonly iterations?: number;
  readonly design?: Float64Array;
  /** Written as `displacements.f64` (the warm start of a resumed run) when given. */
  readonly displacements?: Float64Array;
  readonly progress?: readonly Record<string, unknown>[];
}

/** A runner whose `topopt` reads the job folder, records it and writes plausible outputs (every voxel 0.5, compliance 5). */
function fakeRunner(options: FakeOptions = {}): ComputeRunner & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    binary: '/fake/llull-compute',
    calls,
    version: () => Promise.resolve('9.9.9'),
    run(args, folder, timeoutMs, onProgress) {
      const files = Object.fromEntries(readdirSync(folder).map((name) => [name, readFileSync(path.join(folder, name))]));
      calls.push({ args, timeoutMs, files });
      for (const event of options.progress ?? []) onProgress?.(event);
      if (options.fail !== undefined) {
        return Promise.resolve<JobRun>({ ok: false, outputs: [], ...options.fail, warnings: [], log: 'solver log tail', elapsedMs: 1 });
      }
      const job = JSON.parse(files['job.json']?.toString() ?? '{}') as { grid: { nx: number; ny: number; nz: number } };
      const voxels = job.grid.nx * job.grid.ny * job.grid.nz;
      const iterations = options.iterations ?? 3;
      const field = Buffer.alloc(4 * voxels);
      for (let i = 0; i < voxels; i += 1) field.writeFloatLE(0.5, 4 * i);
      const design = Buffer.from((options.design ?? new Float64Array(voxels).fill(0.5)).buffer);
      const result = Buffer.from(
        JSON.stringify({
          version: 1,
          status: 'max_iterations',
          iterations,
          compliance: 5,
          perLoadCase: { LC1: 5 },
          history: Array.from({ length: iterations }, (_, k) => ({ it: k + 1, compliance: 10 - k, volume: 0.5, change: 0.1 })),
          device: 'cpu',
          deterministic: true,
        }),
      );
      const outputs: Record<string, Buffer> = { 'field.bin': field, 'design.f64': design, 'result.json': result };
      if (options.displacements !== undefined) outputs['displacements.f64'] = Buffer.from(options.displacements.buffer);
      for (const [name, bytes] of Object.entries(outputs)) writeFileSync(path.join(folder, name), bytes);
      return Promise.resolve<JobRun>({
        ok: true,
        outputs: Object.entries(outputs).map(([name, bytes]) => ({ path: name, sha256: createHash('sha256').update(bytes).digest('hex') })),
        warnings: [{ code: 'TOP_GPU_FALLBACK', message: 'no adapter' }],
        log: '',
        elapsedMs: 7,
      });
    },
  };
}

const missingRunner = (): ComputeRunner => ({
  binary: null,
  run: () => Promise.reject(new Error('never started')),
  version: () => Promise.resolve('unknown'),
});

const f64At = (bytes: Buffer | undefined): number[] => Array.from(new Float64Array(Uint8Array.from(bytes ?? []).buffer));

describe('topology_solve with a fake job runner', () => {
  it('writes the job folder with the shared index conventions and records the artifact', async () => {
    const model = mbbModel();
    const host = hostOf(model);
    const runner = fakeRunner({ progress: [{ type: 'progress', step: 1, total: 300, it: 1, compliance: 10, volume: 0.5, change: 0.2 }] });
    const lines: string[] = [];
    const result = await runTopologySolve('x', {}, host, { store, runner });
    expect(result).toMatchObject({ isError: true, data: { code: 'TOP_STUDY_NOT_FOUND' } });

    const solved = await runTopologySolve(model.studyId, { device: 'cpu' }, host, {
      store,
      runner,
      onProgress: (line) => lines.push(line),
    });
    expect(solved.isError).toBe(false);
    const [call] = runner.calls;
    expect(call?.args).toEqual(['topopt']);
    expect(call?.timeoutMs).toBe(1_800_000);
    const job = JSON.parse(call?.files['job.json']?.toString() ?? '{}') as Record<string, unknown>;
    expect(job).toMatchObject({
      version: 1,
      dimension: 2,
      grid: { nx: 60, ny: 20, nz: 1, voxel: 1 },
      material: { e0: 1, nu: 0.3 },
      thickness: 1,
      volumeFraction: 0.5,
      loadCases: [{ name: 'LC1', weight: 1, forces: 'lc0.f64' }],
      settings: {
        penal: 3,
        eminRatio: 1e-9,
        move: 0.2,
        changeTol: 0.01,
        maxIterations: 300,
        filter: { kind: 'sensitivity', radius: 1.5 },
        device: 'cpu',
      },
    });
    expect(job).not.toHaveProperty('startDesign');
    expect(call?.files['active.u8']).toHaveLength(1200);
    expect(Array.from(call?.files['active.u8'] ?? []).every((flag) => flag === 1)).toBe(true);
    // dof = 2 * node + c, node = i + 61 j: ux = 0 on the left edge (i = 0, j = 0..20), uy = 0 at node (60, 0)
    const fixed = Array.from(call?.files['fixed.u8'] ?? []);
    expect(fixed).toHaveLength(2 * 61 * 21);
    const fixedDofs = fixed.flatMap((flag, dof) => (flag === 1 ? [dof] : []));
    expect(fixedDofs).toEqual([...Array.from({ length: 21 }, (_, j) => 2 * 61 * j), 2 * 60 + 1].sort((a, b) => a - b));
    // the unit load at node (0, 20) = 1220 acts down: dof 2 * 1220 + 1
    const forces = f64At(call?.files['lc0.f64']);
    expect(forces).toHaveLength(2 * 61 * 21);
    expect(forces.flatMap((value, dof) => (value === 0 ? [] : [[dof, value]]))).toEqual([[2 * 1220 + 1, -1]]);

    expect(lines).toEqual(['topology_solve: iteration 1/300 compliance 10.0000 volume 0.500000 change 0.200000']);
    const data = solved.data as { fieldHash: string; record: unknown; warnings: unknown };
    const artifact = store.get(data.fieldHash) as FeTopologyArtifact | null;
    expect(artifact?.kind).toBe('fe_topology');
    expect(sha256Hex(canonicalJson(artifact))).toBe(data.fieldHash);
    expect(artifact?.solver).toEqual({ job: 'topopt', version: '9.9.9', device: 'cpu', deterministic: true });
    expect(artifact).toMatchObject({ compliance: 5, iterations: 3, perLoadCase: { LC1: 5 } });
    expect(data.warnings).toEqual([{ code: 'TOP_GPU_FALLBACK', message: 'no adapter' }]);
    const recorded = studyOf(host.current(), model.analysisId, model.studyId).result;
    expect(recorded).toMatchObject({ fieldHash: data.fieldHash, compliance: 5, solver: { job: 'topopt' } });
    expect(solved.summary).toContain('record_topology_result');
    expect(solved.affected).toContain(model.studyId);
  });

  it('passes timeoutS (clamped) and device to the job', async () => {
    const model = mbbModel();
    const runner = fakeRunner();
    await runTopologySolve(model.studyId, { timeoutS: 5, device: 'auto' }, hostOf(model), { store, runner });
    expect(runner.calls[0]?.timeoutMs).toBe(5000);
    expect(JSON.parse(runner.calls[0]?.files['job.json']?.toString() ?? '{}')).toMatchObject({ settings: { device: 'auto' } });
  });

  it('maps native errors: TOP_SOLVER_FAILED, TOP_GRID_TOO_LARGE, timeout, input errors; the document stays unchanged', async () => {
    const model = mbbModel();
    const cases: [{ code: string; message: string }, string][] = [
      [{ code: 'TOP_SOLVER_FAILED', message: 'PCG did not converge' }, 'TOP_SOLVER_FAILED'],
      [{ code: 'TOP_GRID_TOO_LARGE', message: '5000000 DOFs above the cap' }, 'TOP_GRID_TOO_LARGE'],
      [{ code: 'NATIVE_TIMEOUT', message: 'llull-compute timed out after 5000 ms' }, 'TOP_SOLVER_TIMEOUT'],
      [{ code: 'NATIVE_JOB_INPUT', message: 'bad job' }, 'TOP_SOLVER_FAILED'],
      [{ code: 'NATIVE_PROTOCOL', message: 'no final event' }, 'TOP_SOLVER_FAILED'],
    ];
    for (const [fail, code] of cases) {
      const host = hostOf(model);
      const result = await runTopologySolve(model.studyId, { timeoutS: 5 }, host, { store, runner: fakeRunner({ fail }) });
      expect(result).toMatchObject({ isError: true, data: { code, nativeCode: fail.code } });
      expect(result.summary).toContain(`topology_solve ${code}`);
      expect(host.current()).toBe(model.doc);
    }
  });

  it('runs the TypeScript reference for a small 2D study when llull-compute is missing', async () => {
    const model = mbbModel();
    const host = hostOf(model);
    const result = await runTopologySolve(model.studyId, {}, host, { store, runner: missingRunner() });
    expect(result.isError).toBe(false);
    const data = result.data as { fieldHash: string; solver: { job: string } };
    expect(data.solver.job).toBe('ts-reference');
    expect((store.get(data.fieldHash) as FeTopologyArtifact | null)?.solver.job).toBe('ts-reference');
    expect(studyOf(host.current(), model.analysisId, model.studyId).result?.fieldHash).toBe(data.fieldHash);
  }, 60_000);

  it('answers TOP_TOOL_MISSING (with the NATIVE_TOOL_MISSING hint) above the TypeScript cap and changes nothing', async () => {
    const model = mbbModel({}, (action) =>
      action.command === 'create_topology_study' ? { ...action, params: { ...action.params, voxel: 0.5 } } : action,
    );
    const host = hostOf(model);
    const result = await runTopologySolve(model.studyId, {}, host, { store, runner: missingRunner() });
    expect(result).toMatchObject({ isError: true, data: { code: 'TOP_TOOL_MISSING', nativeCode: 'NATIVE_TOOL_MISSING' } });
    expect(result.summary).toContain('topology_solve TOP_TOOL_MISSING');
    expect(result.summary).toContain('NATIVE_TOOL_MISSING');
    expect(result.summary).toContain('4800 voxels exceed the TypeScript reference cap of 2000');
    expect(host.current()).toBe(model.doc);
  });

  it('refuses an invalid set-up with the job code', async () => {
    const model = mbbModel();
    const stripped = execute(model.doc, 'delete_fea_constraint', { analysisId: model.analysisId, constraintId: 'nope' });
    expect(stripped.rejected).toBe(true);
    const doc = execute(model.doc, 'create_analysis', { name: 'bare', analysisType: 'static' });
    const bare = doc.affected[0] ?? '';
    const withStudy = execute(doc.document, 'create_topology_study', {
      analysisId: bare,
      name: 'bare',
      designDomain: [model.entityId],
      dimension: 2,
      voxel: 1,
      volumeFraction: 0.5,
    });
    const result = await runTopologySolve(withStudy.affected[0] ?? '', {}, hostOf({ ...model, doc: withStudy.document }), {
      store,
      runner: fakeRunner(),
    });
    expect(result).toMatchObject({ isError: true });
    expect(String((result.data as { code: string }).code)).toMatch(/^TOP_/);
  });

  describe('resume', () => {
    it('passes the saved design and displacements of the last finished run as startDesign / startDisplacements and accumulates iterations and history', async () => {
      const model = mbbModel();
      const host = hostOf(model);
      const design = Float64Array.from({ length: 1200 }, (_, i) => (i % 7) / 10);
      const displacements = Float64Array.from({ length: 2 * 61 * 21 }, (_, i) => i / 100);
      const first = fakeRunner({ iterations: 4, design, displacements });
      await runTopologySolve(model.studyId, {}, host, { store, runner: first });
      const second = fakeRunner({ iterations: 2 });
      const result = await runTopologySolve(model.studyId, { resumeFromLast: true }, host, { store, runner: second });
      expect(result.isError).toBe(false);
      const files = second.calls[0]?.files ?? {};
      expect(JSON.parse(files['job.json']?.toString() ?? '{}')).toMatchObject({
        startDesign: 'start.f64',
        startDisplacements: 'start_u.f64',
        settings: { maxIterations: 296 },
      });
      expect(f64At(files['start.f64'])).toEqual(Array.from(design));
      expect(f64At(files['start_u.f64'])).toEqual(Array.from(displacements));
      const data = result.data as { fieldHash: string; resumedFromIteration: number };
      expect(data.resumedFromIteration).toBe(4);
      const artifact = store.get(data.fieldHash) as FeTopologyArtifact | null;
      expect(artifact?.iterations).toBe(6);
      expect(artifact?.history.map((row) => row.it)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(first.calls[0]?.files).not.toHaveProperty('start.f64');
    });

    it('starts fresh and says so when nothing usable was saved (no run yet, or the inputs changed)', async () => {
      const model = mbbModel();
      const none = fakeRunner();
      const result = await runTopologySolve(model.studyId, { resumeFromLast: true }, hostOf(model), { store, runner: none });
      expect(none.calls[0]?.files).not.toHaveProperty('start.f64');
      expect(result.summary).toContain('no saved run of this study');

      const first = hostOf(model);
      await runTopologySolve(model.studyId, {}, first, { store, runner: fakeRunner() });
      const resumed = async (doc: CadDocument): Promise<boolean> => {
        const runner = fakeRunner();
        await runTopologySolve(model.studyId, { resumeFromLast: true }, hostOf({ ...model, doc }), { store, runner });
        return 'start.f64' in (runner.calls[0]?.files ?? {});
      };
      // a raised maxIterations keeps the saved design usable; a changed load does not
      const heavier = execute(model.doc, 'set_topology_settings', { studyId: model.studyId, maxIterations: 500 });
      expect(heavier.rejected).not.toBe(true);
      expect(await resumed(heavier.document)).toBe(true);
      const loadId = Object.keys(model.doc.analysis?.cases[model.analysisId]?.loads ?? {})[0] ?? '';
      const moved = execute(model.doc, 'update_fea_load', { analysisId: model.analysisId, loadId, vector: [0, -2, 0] });
      expect(moved.rejected).not.toBe(true);
      expect(await resumed(moved.document)).toBe(false);
    });
  });
});

describe('topology_solve in the CLI surface', () => {
  it('is an exchange-style tool of the analysis toolset with a generated-free schema that requires studyId', () => {
    const tool = exchangeTool('topology_solve');
    expect(tool?.inputSchema.required).toEqual(['studyId']);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['studyId', 'timeoutS', 'resumeFromLast', 'device']);
    expect(toolsetOf('topology_solve')).toBe('analysis');
  });

  it('runNativeTool requires studyId and reports changed only when the document changed', async () => {
    const model = mbbModel();
    const host = hostOf(model);
    expect(await runNativeTool('topology_solve', {}, host, { store, runner: fakeRunner() })).toMatchObject({
      isError: true,
      changed: false,
    });
    const failed = await runNativeTool('topology_solve', { studyId: model.studyId }, host, {
      store,
      runner: fakeRunner({ fail: { code: 'TOP_SOLVER_FAILED', message: 'x' } }),
    });
    expect(failed).toMatchObject({ isError: true, changed: false });
    const ok = await runNativeTool('topology_solve', { studyId: model.studyId, timeoutS: 9, device: 'cpu' }, host, {
      store,
      runner: fakeRunner(),
    });
    expect(ok).toMatchObject({ isError: false, changed: true });
  });
});

describe('topology_solve over REST', () => {
  it('is served by POST /exchange (not /command: it is a host transport) and refuses an unknown study there', async () => {
    const app = express()
      .use(express.json())
      .use(buildExchangeRouter((_req, _res, next) => next(), { port: null, allowCodeExecution: false }));
    const response = await request(app)
      .post('/exchange')
      .send({ name: 'topology_solve', params: { studyId: 'nope' } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ isError: true, changed: false, data: { code: 'TOP_STUDY_NOT_FOUND' } });
  });
});
