/** Shared fixtures of the cfd transport tests: a sphere case, a host over a mutable document, a fake llull-compute runner. */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { cfdResultPort } from '../src/cfd/resultPort';
import type { FeArtifactCache } from '../src/fea/artifactStore';
import type { ComputeRunner, JobRun } from '../src/native/computeJob';

export const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface Model {
  readonly doc: CadDocument;
  readonly ballId: string;
}

/** A unit-diameter sphere in a metre document with a low-speed case `re100` (U 1 m/s, ν 0.01 m²/s), 8 cells per diameter. */
export function sphereModel(): Model {
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

export type TestHost = FeaHost & { current(): CadDocument; set(doc: CadDocument): void };

/** A host over a mutable document: `record_cfd_results` replaces it, like the CLI's local backend. */
export function hostOf(model: Model, store: FeArtifactCache): TestHost {
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

export interface Call {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly files: Readonly<Record<string, Buffer>>;
}

export interface FakeOptions {
  readonly fail?: { readonly code: string; readonly message: string };
  readonly converged?: boolean;
  readonly warnings?: readonly { code: string; message: string }[];
  readonly device?: 'cpu' | 'gpu';
  /** `flow` waits until `release()` (or its signal aborts: NATIVE_CANCELLED, like the real runner's tree kill). */
  readonly hold?: boolean;
  /** `flow-query`: query.json and its file for the job, or a failure. */
  readonly query?: (
    job: Record<string, unknown>,
  ) => { readonly json: unknown; readonly file?: Buffer } | { readonly fail: { code: string; message: string } };
  /** Writes a field.bin whose header disagrees with result.json. */
  readonly wrongField?: boolean;
  /** Reports a sha256 for field.bin that is not the file's (the job and its output disagree). */
  readonly wrongFieldHash?: boolean;
  /** `version()` rejects (the host's version probe failing after the run). */
  readonly versionFails?: boolean;
}

export interface FakeRunner extends ComputeRunner {
  readonly calls: Call[];
  /** The signal handed to each run, in call order. */
  readonly signals: (AbortSignal | undefined)[];
  /** Lets held `flow` runs finish. */
  release(): void;
}

/** An LLFD field file of the fake result grid (20 x 12 x 12 cells of 0.125 m from [-1, -0.75, -0.75]). */
export function fakeField(nx = 20): Buffer {
  const [ny, nz] = [12, 12];
  const bytes = Buffer.alloc(56 + 17 * nx * ny * nz);
  bytes.write('LLFD', 0, 'latin1');
  bytes.writeUInt32LE(1, 4);
  [nx, ny, nz].forEach((n, k) => bytes.writeUInt32LE(n, 8 + 4 * k));
  bytes.writeDoubleLE(0.125, 20);
  [-1, -0.75, -0.75].forEach((o, k) => bytes.writeDoubleLE(o, 28 + 8 * k));
  return bytes;
}

const cancelled = (): JobRun => ({
  ok: false,
  outputs: [],
  code: 'NATIVE_CANCELLED',
  message: 'llull-compute was cancelled',
  warnings: [],
  log: '',
  elapsedMs: 1,
});

function answerQuery(folder: string, options: FakeOptions): JobRun {
  const job = JSON.parse(readFileSync(path.join(folder, 'job.json'), 'utf8')) as Record<string, unknown>;
  // the gate of llull_flow_core::query: the field in the folder must hash to the one the bundle names
  if (sha(readFileSync(path.join(folder, 'field.bin'))) !== job['fieldSha256'])
    return {
      ok: false,
      outputs: [],
      code: 'CFD_RESULT_HASH_MISMATCH',
      message: 'field.bin does not hash to fieldSha256',
      warnings: [],
      log: '',
      elapsedMs: 1,
    };
  const answer = options.query?.(job) ?? { fail: { code: 'NATIVE_JOB_INPUT', message: 'no query answer configured' } };
  if ('fail' in answer) return { ok: false, outputs: [], ...answer.fail, warnings: [], log: 'query log tail', elapsedMs: 1 };
  const outputs: Record<string, Buffer> = { 'query.json': Buffer.from(JSON.stringify(answer.json)) };
  if (answer.file !== undefined) outputs[job['op'] === 'slice' ? 'slice.bin' : 'streamlines.bin'] = answer.file;
  for (const [name, bytes] of Object.entries(outputs)) writeFileSync(path.join(folder, name), bytes);
  return {
    ok: true,
    outputs: Object.entries(outputs).map(([name, bytes]) => ({ path: name, sha256: sha(bytes) })),
    warnings: [],
    log: '',
    elapsedMs: 2,
  };
}

/** A runner whose `flow` reads case.json, records the folder and writes a consistent result bundle (drag 0.5 N, lift 0.02 N). */
export function fakeRunner(options: FakeOptions = {}): FakeRunner {
  const calls: Call[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    binary: '/fake/llull-compute',
    calls,
    signals,
    release: () => release(),
    version: () => (options.versionFails === true ? Promise.reject(new Error('version probe: EPERM')) : Promise.resolve('9.9.9')),
    async run(args, folder, timeoutMs, onProgress, signal) {
      const files = Object.fromEntries(readdirSync(folder).map((name) => [name, readFileSync(path.join(folder, name))]));
      calls.push({ args, timeoutMs, files });
      signals.push(signal);
      if (args[0] === 'flow-query') return signal?.aborted === true ? cancelled() : answerQuery(folder, options);
      if (options.hold === true) {
        const aborted = new Promise<'aborted'>((resolve) => {
          if (signal?.aborted === true) resolve('aborted');
          signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        if ((await Promise.race([aborted, released])) === 'aborted') return cancelled();
      }
      onProgress?.({ type: 'progress', step: 40, total: 200, message: 'x', cd: 1.2, dragN: 0.47, change: 0.012, phase: 'transient' });
      if (options.fail !== undefined)
        return { ok: false, outputs: [], ...options.fail, warnings: [], log: 'solver log tail', elapsedMs: 1 };
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
        field: 'field.bin',
        slices: job.outputs.slices.map((_, k) => `slice-${k}.bin`),
        notModelled: ['wall-resolved boundary layer'],
        warnings: options.warnings ?? [],
      };
      const outputs: Record<string, Buffer> = {
        'surface.bin': Buffer.from([76, 76, 83, 70, 1, 0, 0, 0]),
        'field.bin': fakeField(options.wrongField === true ? 21 : 20),
        'result.json': Buffer.from(JSON.stringify(result)),
      };
      job.outputs.slices.forEach((_, k) => {
        outputs[`slice-${k}.bin`] = Buffer.from([76, 76, 83, 76, k]);
      });
      for (const [name, bytes] of Object.entries(outputs)) writeFileSync(path.join(folder, name), bytes);
      return {
        ok: true,
        outputs: Object.entries(outputs).map(([name, bytes]) => ({
          path: name,
          sha256: name === 'field.bin' && options.wrongFieldHash === true ? 'e'.repeat(64) : sha(bytes),
        })),
        warnings: options.warnings ?? [],
        log: '',
        elapsedMs: 9,
      };
    },
  };
}

export const missingRunner = (): ComputeRunner => ({
  binary: null,
  run: () => Promise.reject(new Error('never started')),
  version: () => Promise.resolve('unknown'),
});
