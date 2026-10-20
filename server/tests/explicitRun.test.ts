/**
 * explicit_run transport (PHY-19 RS-8a) with an injected fake job runner (no binary): job folder contents, artifact + record, EXP_TOOL_MISSING
 * without llull-compute (VC-EXP-57 analogue), native error / timeout mapping and the tool registration. The real binary is
 * `explicitRunNative.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { FeExplicitArtifact } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import type { ComputeRunner, JobRun } from '../src/native/computeJob';
import { runExplicitRun } from '../src/native/explicitRun';
import { isNativeTool, nativeToolDefinitions, runNativeTool } from '../src/native/tools';
import { barModel, type BarModel } from '../../tests/unit/cae/explicit/support';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-explicit-store-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function hostOf(model: BarModel): FeaHost & { current(): CadDocument } {
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

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A runner whose `explicit` records the job folder and writes a plausible result (one wall pulse, every element at 100). */
function fakeRunner(fail?: { code: string; message: string }): ComputeRunner & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    binary: '/fake/llull-compute',
    calls,
    version: () => Promise.resolve('9.9.9'),
    run(args, folder, timeoutMs, onProgress) {
      const files = Object.fromEntries(readdirSync(folder).map((name) => [name, readFileSync(path.join(folder, name))]));
      calls.push({ args, timeoutMs, files });
      onProgress?.({ type: 'progress', cycle: 10, time: 1e-5, endTime: 1.6e-4, dt: 1e-6 });
      if (fail !== undefined) return Promise.resolve<JobRun>({ ok: false, outputs: [], ...fail, warnings: [], log: 'tail', elapsedMs: 1 });
      const job = JSON.parse(files['job.json']?.toString('utf8') ?? '{}') as { hex8?: string };
      const elements = (files[job.hex8 ?? '']?.length ?? 0) / 32;
      const fields = Buffer.from(new Float64Array(7 * elements).fill(100).buffer);
      const result = Buffer.from(
        JSON.stringify({
          version: 1,
          termination: 'normal',
          message: '',
          cycles: 500,
          finalTime: 1.6e-4,
          minTimeStep: 3e-7,
          initialMass: 1.57e-4,
          addedMass: 0,
          device: 'cpu',
          deterministic: true,
          energy: [
            [0, 7.85, 0, 0, 0, 0, 0],
            [1.6e-4, 7.8, 0.04, 0, 0.01, 0, 0],
          ],
          walls: [{ name: 'anvil', t: [8e-5], force: [39600] }],
        }),
      );
      writeFileSync(path.join(folder, 'fields.f64'), fields);
      writeFileSync(path.join(folder, 'result.json'), result);
      return Promise.resolve<JobRun>({
        ok: true,
        outputs: [
          { path: 'fields.f64', sha256: sha(fields) },
          { path: 'result.json', sha256: sha(result) },
        ],
        warnings: [{ code: 'EXP_GPU_FALLBACK', message: 'cpu' }],
        log: '',
        elapsedMs: 5,
      });
    },
  };
}

describe('explicit_run transport', () => {
  it('writes the job folder, stores the artifact and records the verified summary', async () => {
    const model = barModel({ size: 5 });
    const host = hostOf(model);
    const runner = fakeRunner();
    const lines: string[] = [];
    const result = await runExplicitRun(model.analysisId, { device: 'gpu' }, host, {
      store,
      runner,
      onProgress: (line) => lines.push(line),
    });
    expect(result.isError, result.summary).toBe(false);
    const call = runner.calls[0];
    expect(call?.args).toEqual(['explicit']);
    expect(call?.timeoutMs).toBe(3600 * 1000);
    expect(Object.keys(call?.files ?? {}).sort()).toEqual(['elmat.u32', 'hex8.u32', 'job.json', 'nodes.f64', 'velocity.f64']);
    const job = JSON.parse(call?.files['job.json']?.toString('utf8') ?? '{}') as Record<string, unknown>;
    expect(job).toMatchObject({
      version: 1,
      device: 'gpu',
      gravity: [0, 0, 0],
      walls: [{ name: 'anvil', point: [5, 5, 0], normal: [0, 0, 1] }],
      materials: [{ youngsModulus: 200000, poisson: 0.3 }],
      controls: {
        endTime: 0.00016,
        historyInterval: 1e-6,
        timeStepScale: 0.9,
        hourglassCoefficient: 0.1,
        bulkLinear: 0.06,
        bulkQuadratic: 1.5,
      },
    });
    expect(call?.files['hex8.u32']?.length).toBe(160 * 8 * 4);
    expect(lines[0]).toContain('explicit_run: cycle 10');
    const hash = (result.data as { artifactHash: string }).artifactHash;
    expect((store.get(hash) as FeExplicitArtifact).kind).toBe('fe_explicit');
    expect(result.summary).toContain('EXP_GPU_FALLBACK');
    expect(host.current().analysis?.cases[model.analysisId]?.explicit?.results?.artifactHash).toBe(hash);
    const report = execute(
      host.current(),
      'explicit_report',
      { analysisId: model.analysisId },
      { ...defaultContext(), feaArtifacts: store },
    );
    expect((report.data as { state: string }).state).toBe('solved');
  });

  it('refuses without llull-compute (EXP_TOOL_MISSING) and maps native failures', async () => {
    const model = barModel({ size: 5 });
    const missing: ComputeRunner = {
      binary: null,
      version: () => Promise.resolve('unknown'),
      run: () => Promise.reject(new Error('never')),
    };
    const none = await runExplicitRun(model.analysisId, {}, hostOf(model), { store, runner: missing });
    expect(none.isError).toBe(true);
    expect(none.data).toMatchObject({ code: 'EXP_TOOL_MISSING', nativeCode: 'NATIVE_TOOL_MISSING' });
    const timeout = await runExplicitRun(model.analysisId, { timeoutS: 5 }, hostOf(model), {
      store,
      runner: fakeRunner({ code: 'NATIVE_TIMEOUT', message: 'slow' }),
    });
    expect(timeout.data).toMatchObject({ code: 'EXP_RUN_TIMEOUT', nativeCode: 'NATIVE_TIMEOUT' });
    const failed = await runExplicitRun(model.analysisId, {}, hostOf(model), {
      store,
      runner: fakeRunner({ code: 'EXP_SOLVER_FAILED', message: 'x' }),
    });
    expect(failed.data).toMatchObject({ code: 'EXP_SOLVER_FAILED' });
    const unknown = await runExplicitRun('an-404', {}, hostOf(model), { store, runner: fakeRunner() });
    expect(unknown.data).toMatchObject({ code: 'FEA_ANALYSIS_NOT_FOUND' });
  });

  it('is a registered native tool with a schema', async () => {
    expect(isNativeTool('explicit_run')).toBe(true);
    const definition = nativeToolDefinitions().find((tool) => tool.name === 'explicit_run');
    expect(definition?.inputSchema.required).toEqual(['analysisId']);
    const model = barModel({ size: 5 });
    const outcome = await runNativeTool('explicit_run', {}, hostOf(model), { store, runner: fakeRunner() });
    expect(outcome?.isError).toBe(true);
    const ran = await runNativeTool('explicit_run', { analysisId: model.analysisId, device: 'cpu', timeoutS: 10 }, hostOf(model), {
      store,
      runner: fakeRunner(),
    });
    expect(ran?.changed).toBe(true);
  });
});
