/**
 * cfd_solve transport (12 CFD M2) with an injected fake job runner (no binary): job folder contents (case.json + surface.stl), bundle + record,
 * CFD_SOLVER_MISSING without llull-compute, VC-CFD-50 memory refusal before the run, VC-CFD-51 fallback warning passthrough, VC-CFD-52 stale
 * result after the body moved, VC-CFD-55 step-limited run recorded with CFD_NOT_CONVERGED, native error / timeout mapping, tool wiring. The
 * real binary is `cfdSolveNative.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { cfdResultPort } from '../src/cfd/resultPort';
import { DEFAULT_CFD_TIMEOUT_S, runCfdSolve } from '../src/cfd/flowSolve';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import type { ComputeRunner, JobRun } from '../src/native/computeJob';
import { isNativeTool, runNativeTool } from '../src/native/tools';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-store-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Model {
  readonly doc: CadDocument;
  readonly ballId: string;
}

/** A unit-diameter sphere in a metre document with a low-speed case `re100` (U 1 m/s, ν 0.01 m²/s), 8 cells per diameter. */
function sphereModel(): Model {
  let doc: CadDocument = { ...createEmptyDocument(), units: 'm' };
  const added = execute(doc, 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
  doc = added.document;
  const ballId = added.affected[0] as string;
  doc = execute(doc, 'create_cfd_case', {
    id: 're100',
    entityIds: [ballId],
    freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.01 } },
    reference: { areaM2: 0.7853981634, lengthM: 1 },
    cellsPerReferenceLength: 8,
    outputs: { probes: [[2, 0, 0]], slices: [{ origin: [0, 0, 0], normal: [0, 1, 0], field: 'speed' }] },
  }).document;
  return { doc, ballId };
}

/** A host over a mutable document: `record_cfd_results` replaces it, like the CLI's local backend. */
function hostOf(model: Model): FeaHost & { current(): CadDocument; set(doc: CadDocument): void } {
  let doc = model.doc;
  return {
    current: () => doc,
    set: (next) => {
      doc = next;
    },
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store, cfdResults: cfdResultPort(store) });
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
  readonly converged?: boolean;
  readonly warnings?: readonly { code: string; message: string }[];
  readonly device?: 'cpu' | 'gpu';
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A runner whose `flow` reads case.json, records the folder and writes a consistent result bundle (drag 0.5 N, lift 0.02 N). */
function fakeRunner(options: FakeOptions = {}): ComputeRunner & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    binary: '/fake/llull-compute',
    calls,
    version: () => Promise.resolve('9.9.9'),
    run(args, folder, timeoutMs, onProgress) {
      const files = Object.fromEntries(readdirSync(folder).map((name) => [name, readFileSync(path.join(folder, name))]));
      calls.push({ args, timeoutMs, files });
      onProgress?.({ type: 'progress', step: 40, total: 200, message: 'x', cd: 1.2, dragN: 0.47, change: 0.012, phase: 'transient' });
      if (options.fail !== undefined)
        return Promise.resolve<JobRun>({ ok: false, outputs: [], ...options.fail, warnings: [], log: 'solver log tail', elapsedMs: 1 });
      const job = JSON.parse(files['case.json']?.toString('utf8') ?? '{}') as {
        caseId: string;
        flow: { speedMS: number; densityKgM3: number };
        reference: { areaM2: number; lengthM: number };
        bodies: Array<{ entityId: string }>;
        settings: { maxSteps: number };
        outputs: { slices: unknown[] };
      };
      const q = 0.5 * job.flow.densityKgM3 * job.flow.speedMS ** 2;
      const qArea = q * job.reference.areaM2;
      const totalN = [0.5, 0.01, 0.02];
      const converged = options.converged ?? true;
      const result = {
        version: 1,
        caseId: job.caseId,
        solver: 'lbm',
        status: converged ? 'converged' : 'max_steps',
        converged,
        steps: converged ? 1200 : job.settings.maxSteps,
        averagedSteps: converged ? 400 : 0,
        samples: 20,
        timeS: 3,
        elapsedS: 1,
        device: options.device ?? 'cpu',
        ...(options.device === 'gpu' ? { adapter: 'Fake GPU (Vulkan, DiscreteGpu)' } : {}),
        deterministic: options.device !== 'gpu',
        precision: options.device === 'gpu' ? 'f32' : 'f64',
        halfModel: false,
        memory: { bytesPerCell: options.device === 'gpu' ? 204 : 395, gpuBytesPerCell: 204, cpuBytesPerCell: 395, bytes: 2880 * 395 },
        grid: {
          nx: 20,
          ny: 12,
          nz: 12,
          cellM: 0.125,
          cells: 2880,
          fluidCells: 2800,
          solidCells: 33,
          oddRows: 0,
          originM: [-1, -0.75, -0.75],
        },
        lattice: {
          tau: 0.6,
          uLattice: 0.0577,
          nuLattice: 0.03,
          dtS: 0.007,
          flowThroughSteps: 400,
          sampleEvery: 8,
          les: true,
          smagorinsky: 0.1,
          reynolds: 100,
        },
        forces: {
          totalN,
          momentNm: [0, 0, 0],
          dragN: 0.5,
          liftN: 0.02,
          sideN: 0.01,
          cd: 0.5 / qArea,
          cl: 0.02 / qArea,
          cs: 0.01 / qArea,
          cm: [0, 0, 0],
          cdAM2: 0.5 / q,
          dynamicPressurePa: q,
          referenceAreaM2: job.reference.areaM2,
          referenceLengthM: job.reference.lengthM,
          dragAxis: [1, 0, 0],
          liftAxis: [0, 0, 1],
          sideAxis: [0, 1, 0],
        },
        perBody: job.bodies.map((body) => ({ entityId: body.entityId, forceN: totalN })),
        peaks: [{ field: 'p', min: -0.6, max: 0.5, minAt: [0, 0.5, 0], maxAt: [-0.5, 0, 0], unit: 'Pa' }],
        probes: [{ pointM: [2, 0, 0], velocityMS: [0.8, 0, 0], speedMS: 0.8, pressurePa: -0.01 }],
        history: [{ step: 400, timeS: 1, dragN: 0.6, cd: 1.5, forceN: [0.6, 0, 0], change: null, phase: 'transient' }],
        settings: {},
        surface: 'surface.bin',
        slices: job.outputs.slices.map((_, k) => `slice-${k}.bin`),
        notModelled: ['wall-resolved boundary layer'],
        warnings: options.warnings ?? [],
      };
      const outputs: Record<string, Buffer> = {
        'surface.bin': Buffer.from([76, 76, 83, 70, 1, 0, 0, 0]),
        'result.json': Buffer.from(JSON.stringify(result)),
      };
      job.outputs.slices.forEach((_, k) => {
        outputs[`slice-${k}.bin`] = Buffer.from([76, 76, 83, 76, k]);
      });
      for (const [name, bytes] of Object.entries(outputs)) writeFileSync(path.join(folder, name), bytes);
      return Promise.resolve<JobRun>({
        ok: true,
        outputs: Object.entries(outputs).map(([name, bytes]) => ({ path: name, sha256: sha(bytes) })),
        warnings: options.warnings ?? [],
        log: '',
        elapsedMs: 9,
      });
    },
  };
}

const missingRunner = (): ComputeRunner => ({
  binary: null,
  run: () => Promise.reject(new Error('never started')),
  version: () => Promise.resolve('unknown'),
});

describe('cfd_solve with a fake job runner', () => {
  it('writes the job folder, stores the bundle and records the summary through record_cfd_results', async () => {
    const model = sphereModel();
    const host = hostOf(model);
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
    const host = hostOf(model);
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
    const host = hostOf(model);
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
    const host = hostOf(model);
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
    const host = hostOf(model);
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

  it('refuses out-of-range maxSteps and latticeMach before anything runs', async () => {
    const host = hostOf(sphereModel());
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
    const host = hostOf(model);
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
