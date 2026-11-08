/**
 * cfd_solve transport (12 CFD M2) with an injected fake job runner (no binary): job folder contents (case.json + surface.stl), bundle + record,
 * CFD_SOLVER_MISSING without llull-compute, VC-CFD-50 memory refusal before the run, VC-CFD-51 fallback warning passthrough, VC-CFD-52 stale
 * result after the body moved, VC-CFD-55 step-limited run recorded with CFD_NOT_CONVERGED, native error / timeout mapping, tool wiring. The
 * real binary is `cfdSolveNative.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { cfdResultPort } from '../src/cfd/resultPort';
import { _stopAllCfdSolves, DEFAULT_CFD_TIMEOUT_S, runCfdSolve } from '../src/cfd/flowSolve';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { isNativeTool, runNativeTool } from '../src/native/tools';
import { cfdFileStore, hashFile } from '../src/cfd/fileStore';
import { fakeField, fakeRunner, hostOf, missingRunner, sha, sphereModel } from './cfdTestSupport';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-store-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => {
  _stopAllCfdSolves();
  rmSync(dir, { recursive: true, force: true });
});

describe('cfd_solve with a fake job runner', () => {
  it('writes the job folder, stores the bundle and records the summary through record_cfd_results', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const runner = fakeRunner();
    const lines: string[] = [];
    expect(await runCfdSolve('nope', {}, host, { store, runner })).toMatchObject({ isError: true, data: { code: 'CFD_CASE_NOT_FOUND' } });

    const solved = await runCfdSolve('re100', { maxSteps: 200, les: false }, host, {
      store,
      runner,
      onProgress: (line) => lines.push(line),
    });
    expect(solved.isError, solved.summary).toBe(false);
    const [call] = runner.calls;
    expect(call?.args).toEqual(['flow']);
    expect(call?.timeoutMs).toBe(DEFAULT_CFD_TIMEOUT_S * 1000);
    expect(Object.keys(call?.files ?? {}).sort()).toEqual(['case.json', 'surface.stl']);
    const job = JSON.parse(call?.files['case.json']?.toString('utf8') ?? '{}') as Record<string, unknown>;
    expect(job).toMatchObject({
      version: 1,
      caseId: 're100',
      flow: { speedMS: 1, direction: [1, 0, 0], densityKgM3: 1, viscosityPaS: 0.01 },
      reference: { areaM2: 0.7853981634, lengthM: 1 },
      bodies: [{ entityId: model.ballId }],
      settings: { maxSteps: 200, les: false, device: 'cpu', latticeMach: 0.1 },
      outputs: { probesM: [[2, 0, 0]], slices: [{ field: 'speed' }] },
    });
    const stl = call?.files['surface.stl'];
    expect(stl?.readUInt32LE(80)).toBe(((stl?.length ?? 0) - 84) / 50);
    expect(lines).toEqual(['cfd_solve: step 40/200 drag 0.4700 N Cd 1.200 (transient, change 1.20e-2)']);

    const data = solved.data as { resultsHash: string; converged: boolean; forces: { cd: number }; record: unknown; warnings?: unknown };
    const artifact = store.getAny(data.resultsHash) as CfdResultArtifact | null;
    expect(artifact?.kind).toBe('cfd_result');
    expect(sha256Hex(canonicalJson(artifact))).toBe(data.resultsHash);
    expect(artifact?.slices).toEqual([{ name: 'slice-0.bin', base64: 'TExTTAA=' }]);
    // M3a: the field file is kept beside the bundle, content-addressed, and the bundle binds it by hash.
    const field = fakeField();
    expect(artifact?.field).toEqual({ sha256: sha(field), bytes: field.length });
    expect(cfdFileStore(store.directory).get(sha(field))?.equals(field)).toBe(true);
    expect(data.converged).toBe(true);
    expect(data.forces.cd).toBeCloseTo(0.5 / (0.5 * 0.7853981634), 10);
    expect(data.warnings).toBeUndefined();
    const recorded = host.current().cfd?.results['re100'];
    expect(recorded).toMatchObject({ resultsHash: data.resultsHash, verified: true, converged: true });
    expect(solved.summary).toContain('record_cfd_results: re100 converged');
    expect(solved.affected).toEqual(['re100']);

    const report = execute(host.current(), 'cfd_report', { caseId: 're100' }, { ...defaultContext(), cfdResults: cfdResultPort(store) });
    expect(report.data).toMatchObject({ stale: false, trusted: true, converged: true });
  });

  it('refuses without the binary (CFD_SOLVER_MISSING) and before allocating when the estimate exceeds the device (VC-CFD-50)', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const missing = await runCfdSolve('re100', {}, host, { store, runner: missingRunner() });
    expect(missing).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_MISSING', nativeCode: 'NATIVE_TOOL_MISSING' } });
    expect(missing.summary).toContain('NATIVE_TOOL_MISSING');
    const runner = fakeRunner();
    const refused = await runCfdSolve('re100', { deviceMemoryBytes: 1000 }, host, { store, runner });
    expect(refused).toMatchObject({ isError: true, data: { code: 'CFD_MEMORY_EXCEEDED' } });
    const checks = (refused.data as { checks: Array<{ code: string; bytes: number }> }).checks;
    expect(checks[0]?.code).toBe('CFD_MEMORY_EXCEEDED');
    expect(checks[0]?.bytes).toBeGreaterThan(1000);
    expect(runner.calls).toHaveLength(0);
    expect(host.current().cfd?.results['re100']).toBeUndefined();
  });

  it('records a step-limited run with converged false and CFD_NOT_CONVERGED (VC-CFD-55) and passes fallback warnings through (VC-CFD-51)', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const warnings = [{ code: 'CFD_GPU_UNAVAILABLE', message: 'no usable GPU adapter (none): the CPU backend is used (slower)' }];
    const runner = fakeRunner({ converged: false, warnings });
    const solved = await runCfdSolve('re100', { maxSteps: 100, device: 'auto' }, host, { store, runner });
    expect(solved.isError).toBe(false);
    const data = solved.data as { converged: boolean; steps: number; warnings: Array<{ code: string }>; device: string };
    expect(data.converged).toBe(false);
    expect(data.steps).toBe(100);
    expect(data.device).toBe('cpu');
    expect(data.warnings.map((entry) => entry.code)).toEqual(['CFD_GPU_UNAVAILABLE', 'CFD_NOT_CONVERGED']);
    expect(solved.summary).toContain('CFD_NOT_CONVERGED');
    expect(host.current().cfd?.results['re100']).toMatchObject({ converged: false, verified: true });
    const job = JSON.parse(runner.calls[0]?.files['case.json']?.toString('utf8') ?? '{}') as { settings: { device: string } };
    expect(job.settings.device).toBe('auto');
  });

  it('flags the recorded result stale once the body moves (VC-CFD-52) and refuses a stale record', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const runner = fakeRunner();
    const solved = await runCfdSolve('re100', {}, host, { store, runner });
    expect(solved.isError).toBe(false);
    const ctx = { ...defaultContext(), cfdResults: cfdResultPort(store) };
    const moved = execute(host.current(), 'move_entities', { ids: [model.ballId], delta: [0.25, 0, 0] }).document;
    const report = execute(moved, 'cfd_report', { caseId: 're100' }, ctx);
    expect(report.data).toMatchObject({ stale: true, staleReasons: ['the flow surface changed since the solve'] });
    expect((report.data as { warnings: Array<{ code: string }> }).warnings[0]?.code).toBe('CFD_RESULT_STALE');
    const { resultsHash } = solved.data as { resultsHash: string };
    expect(execute(moved, 'record_cfd_results', { caseId: 're100', resultsHash }, ctx)).toMatchObject({
      rejected: true,
      error: { code: 'CFD_INPUT_STALE' },
    });
  });

  it('maps native failures to CFD codes and keeps the job code', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const unstable = await runCfdSolve('re100', {}, host, {
      store,
      runner: fakeRunner({ fail: { code: 'CFD_UNSTABLE_PARAMS', message: 'tau too low' } }),
    });
    expect(unstable).toMatchObject({ isError: true, data: { code: 'CFD_UNSTABLE_PARAMS', nativeCode: 'CFD_UNSTABLE_PARAMS' } });
    const crashed = await runCfdSolve('re100', {}, host, {
      store,
      runner: fakeRunner({ fail: { code: 'NATIVE_PROTOCOL', message: 'exit 2' } }),
    });
    expect(crashed).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED', nativeCode: 'NATIVE_PROTOCOL' } });
    expect(crashed.summary).toContain('solver log tail');
    const timedOut = await runCfdSolve('re100', { timeoutS: 5 }, host, {
      store,
      runner: fakeRunner({ fail: { code: 'NATIVE_TIMEOUT', message: 'timed out' } }),
    });
    expect(timedOut).toMatchObject({ isError: true, data: { code: 'CFD_TIMEOUT' } });
    expect(timedOut.summary).toContain('after 5 s');
    expect(host.current().cfd?.results['re100']).toBeUndefined();
  });

  it('refuses a field file that is not on the grid of result.json and records nothing', async () => {
    const host = hostOf(sphereModel(), store);
    const solved = await runCfdSolve('re100', {}, host, { store, runner: fakeRunner({ wrongField: true }) });
    expect(solved).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED' } });
    expect(solved.summary).toContain('not on the grid');
    expect(host.current().cfd?.results['re100']).toBeUndefined();
  });

  it('keeps nothing when field.bin does not hash to what the job reported (compared before any copy)', async () => {
    const host = hostOf(sphereModel(), store);
    const solved = await runCfdSolve('re100', {}, host, { store, runner: fakeRunner({ wrongFieldHash: true }) });
    expect(solved).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED' } });
    expect(solved.summary).toContain('the job reported');
    const files = path.join(store.directory, 'cfd-files');
    expect(existsSync(files) ? readdirSync(files) : []).toEqual([]);
    expect(host.current().cfd?.results['re100']).toBeUndefined();
  });

  it('stores the same field from concurrent callers: every store succeeds and one file remains', async () => {
    const files = cfdFileStore(store.directory);
    const source = path.join(dir, 'shared-field.bin');
    writeFileSync(source, Buffer.alloc(4 * 1024 * 1024, 3));
    const known = await hashFile(source);
    const stored = await Promise.all(Array.from({ length: 8 }, () => files.putFile(source, known)));
    expect(stored).toEqual(Array.from({ length: 8 }, () => known));
    expect(readdirSync(files.directory)).toEqual([`${known.sha256}.bin`]);
  });

  it('refuses out-of-range maxSteps and latticeMach before anything runs', async () => {
    const host = hostOf(sphereModel(), store);
    const runner = fakeRunner();
    expect(await runCfdSolve('re100', { maxSteps: 0 }, host, { store, runner })).toMatchObject({
      isError: true,
      data: { code: 'CFD_PARAM_INVALID' },
    });
    expect(await runCfdSolve('re100', { latticeMach: 0.5 }, host, { store, runner })).toMatchObject({
      isError: true,
      data: { code: 'CFD_PARAM_INVALID' },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('is wired as the native tool cfd_solve', async () => {
    expect(isNativeTool('cfd_solve')).toBe(true);
    const model = sphereModel();
    const host = hostOf(model, store);
    const invalid = await runNativeTool('cfd_solve', {}, host, { store, runner: fakeRunner() });
    expect(invalid).toMatchObject({ isError: true, changed: false });
    const outcome = await runNativeTool('cfd_solve', { caseId: 're100', device: 'gpu', maxSteps: 50 }, host, {
      store,
      runner: fakeRunner({ device: 'gpu' }),
    });
    expect(outcome).toMatchObject({ isError: false, changed: true });
    expect((outcome?.data as { device: string; adapter: string }).adapter).toBe('Fake GPU (Vulkan, DiscreteGpu)');
    expect(host.current().cfd?.results['re100']?.provenance.device).toEqual({
      backend: 'vulkan',
      name: 'Fake GPU (Vulkan, DiscreteGpu)',
      driver: '',
    });
  });
});
