/**
 * Native `MeshProcessingEngine` (07 MSH TR-MSH-03, RS1 RS-9): `decimate`, `smooth`, `deviation` and `quad_remesh` (M6, QuadriFlow) run `llull-compute meshops` on a job folder
 * (`job.json` + little-endian `positions.f64` / `indices.u32`, contract in `solver/crates/llull-meshops/src/lib.rs`) for meshes of any size.
 * The Rust code reproduces the TypeScript engine bit for bit (VC-MSH-32), so `deterministic: true` and the TS engine stays the oracle below
 * its cap (`quad_remesh` has no TypeScript twin).
 * The port is synchronous but a job takes seconds to minutes, so the engine never runs one inline: it answers from the host's result table
 * (`deferredRun.ts`, TECHNICAL_SPEC 13.8) or asks the host for the job and answers `deferMeshOp`; the host awaits the job on the event loop
 * (progress events, cancellation, `MESH_TIMEOUT`) and runs the command again. Outside `resolveDeferred` the engine refuses (`MESH_ENGINE_NEEDS_HOST`).
 * Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_MESH_OP_TIMEOUT_S (default 600), LLULL_MESH_CACHE_MB (kept results, default 512),
 * LLULL_MESH_HEARTBEAT_MS (silent-job heartbeat, default 5000), LLULL_NATIVE_KEEP=1.
 */

import { createHash } from 'node:crypto';
import type { MeshData } from '@core/model/types';
import { deferMeshOp } from '@core/geometry/mesh/engine';
import { DECIMATE_DESCRIPTION, QUAD_DESCRIPTION, editableProblem, smoothDescription } from '@core/geometry/mesh/editable';
import type { DeviationSummary } from '@core/geometry/mesh/deviation';
import type { MeshEngineFailure, MeshOp, MeshOpName, MeshOpResult, MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { positiveInteger } from '../env';
import { createComputeRunner, readOutput, withJobFolder, type ComputeRunner, type JobRun } from './computeJob';
import { configureResultCache, currentScope, keptResult, type JobOutcome } from './deferredRun';
import { nativeBinaryPath } from './nativeBinary';

const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_HEARTBEAT_MS = 5000;
/** Named guard: input triangles above which quad_remesh refuses (QuadriFlow memory and time grow with the mesh; decimate_mesh first). */
const QUAD_REMESH_TRIANGLE_CAP = 500_000;
/** The vendored QuadriFlow commit (solver/crates/llull-quadflow/vendor/README.md), recorded in the provenance of every result with the platform: the float code differs between compilers, so a result is reproducible per platform build. */
const QUADRIFLOW_LIBRARY = ` + QuadriFlow@810b7a0 (${process.platform}-${process.arch})`;

const CAPABILITIES: ReadonlyMap<MeshOpName, number> = new Map<MeshOpName, number>([
  ['decimate', Infinity],
  ['smooth', Infinity],
  ['deviation', Infinity],
  ['quad_remesh', QUAD_REMESH_TRIANGLE_CAP],
]);

const failure = (code: string, message: string): MeshEngineFailure => ({ code, message });

const regionOf = (region: { readonly center: readonly number[]; readonly radius: number } | undefined): Record<string, unknown> =>
  region === undefined ? {} : { center: [...region.center], radius: region.radius };

type NativeOp = Extract<MeshOp, { op: 'decimate' | 'smooth' | 'deviation' | 'quad_remesh' }>;

/** The job parameters (JSON) of a supported op; `Math.cos` of the feature angle is computed here, as the TypeScript engine does. */
function jobParams(op: NativeOp): Record<string, unknown> {
  if (op.op === 'deviation') return { maxSamples: op.maxSamples };
  if (op.op === 'quad_remesh')
    return {
      targetFaces: op.targetQuads,
      adaptive: op.adaptive,
      preserveSharp: op.hardEdgeRad !== undefined,
      sharpCos: op.hardEdgeRad === undefined ? 0 : Math.cos(op.hardEdgeRad),
    };
  if (op.op === 'decimate')
    return {
      preserveBoundary: op.preserveBoundary,
      ...(op.targetTriangles !== undefined ? { targetTriangles: op.targetTriangles } : {}),
      ...(op.maxDeviation !== undefined ? { maxDeviation: op.maxDeviation } : {}),
      ...(op.featureAngleRad !== undefined ? { featureCos: Math.cos(op.featureAngleRad) } : {}),
      ...(op.lockedRegion !== undefined ? { lockedRegion: regionOf(op.lockedRegion) } : {}),
    };
  return {
    taubin: op.method === 'taubin',
    lambda: op.lambda,
    passBand: op.passBand,
    iterations: op.iterations,
    cotangent: op.weights === 'cotangent',
    fixBoundary: op.fixBoundary,
    volumeCorrection: op.volumeCorrection,
    ...(op.region !== undefined ? { region: regionOf(op.region) } : {}),
  };
}

function packMesh(mesh: MeshData, suffix = ''): Record<string, Buffer> {
  const positions = Buffer.allocUnsafe(mesh.positions.length * 8);
  mesh.positions.forEach((value, i) => positions.writeDoubleLE(value, i * 8));
  const indices = Buffer.allocUnsafe(mesh.indices.length * 4);
  mesh.indices.forEach((value, i) => indices.writeUInt32LE(value, i * 4));
  return { [`positions${suffix}.f64`]: positions, [`indices${suffix}.u32`]: indices };
}

function unpackMesh(positions: Buffer, indices: Buffer): MeshData {
  const outPositions = new Array<number>(positions.length / 8);
  for (let i = 0; i < outPositions.length; i++) outPositions[i] = positions.readDoubleLE(i * 8);
  const outIndices = new Array<number>(indices.length / 4);
  for (let i = 0; i < outIndices.length; i++) outIndices[i] = indices.readUInt32LE(i * 4);
  return { positions: outPositions, indices: outIndices };
}

/** Content key of a job: the op, its parameters and the mesh bytes. */
function keyOf(files: Readonly<Record<string, Buffer | string>>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort())
    hash
      .update(name)
      .update('\0')
      .update(files[name] as Buffer | string)
      .update('\0');
  return hash.digest('hex');
}

/** The failure of a job that did not finish ok. */
function failedJob(op: NativeOp, run: JobRun, timeoutMs: number): MeshEngineFailure {
  if (run.code === 'NATIVE_TIMEOUT') return failure('MESH_TIMEOUT', `llull-compute meshops ${op.op} exceeded ${timeoutMs / 1000} s`);
  if (run.code === 'NATIVE_CANCELLED') return failure('MESH_CANCELLED', `llull-compute meshops ${op.op} was cancelled`);
  if (op.op === 'quad_remesh')
    return failure('MESH_QUAD_REMESH_FAILED', `QuadriFlow: ${run.code ?? 'failed'} — ${run.message ?? ''}`.trim());
  return failure('MESH_ENGINE_UNSUPPORTED', `llull-compute meshops ${op.op}: ${run.code ?? 'failed'} — ${run.message ?? ''}`.trim());
}

/** Read the outputs of a finished job into the engine's result. */
async function resultOf(op: NativeOp, runner: ComputeRunner, folder: string, run: JobRun): Promise<MeshOpResult> {
  const summary: unknown = JSON.parse((await readOutput(folder, run, 'report.json')).toString('utf8'));
  const report = isRecord(summary) && isRecord(summary['report']) ? summary['report'] : {};
  const version = `llull-compute@${await runner.version()}`;
  const provenance = (algorithm: string, reference: string, library = ''): MeshOpResult['provenance'] => ({
    engine: 'native',
    version: `${version}${library}`,
    algorithm,
    reference,
    deterministic: true,
  });
  if (op.op === 'deviation')
    return {
      deviation: report as unknown as DeviationSummary,
      report: {},
      provenance: provenance(
        'closest-surface distance from vertices and triangle centroids, both ways',
        'bounding-volume closest point (Ericson 5.1.5)',
      ),
    };
  const mesh = unpackMesh(await readOutput(folder, run, 'result_positions.f64'), await readOutput(folder, run, 'result_indices.u32'));
  if (op.op === 'quad_remesh')
    return {
      quads: { positions: mesh.positions, quads: mesh.indices },
      report,
      provenance: provenance(QUAD_DESCRIPTION.algorithm, QUAD_DESCRIPTION.reference, QUADRIFLOW_LIBRARY),
    };
  const description = op.op === 'decimate' ? DECIMATE_DESCRIPTION : smoothDescription(op.method === 'taubin');
  return { mesh, report, provenance: provenance(description.algorithm, description.reference) };
}

export interface NativeMeshEngineOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Absolute path of llull-compute (default: located like every native job). */
  readonly binary?: string;
}

/** The native engine, or null when `llull-compute` is not installed. */
export function createNativeMeshEngine(options: NativeMeshEngineOptions = {}): MeshProcessingEngine | null {
  const env = options.env ?? process.env;
  const binary = options.binary ?? nativeBinaryPath('llull-compute', env);
  if (binary === null) return null;
  const timeoutS = Number(env['LLULL_MESH_OP_TIMEOUT_S']);
  const timeoutMs = (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : DEFAULT_TIMEOUT_S) * 1000;
  const heartbeatMs = positiveInteger(env['LLULL_MESH_HEARTBEAT_MS'], DEFAULT_HEARTBEAT_MS);
  const runner = createComputeRunner(env, binary);
  configureResultCache(env);

  /** Runs one job on the event loop; resolves with its result or a named failure, never rejects. */
  const runJob = async (
    op: NativeOp,
    files: Readonly<Record<string, Buffer | string>>,
    signal: AbortSignal,
    report: (event: Readonly<Record<string, unknown>>) => void,
  ): Promise<JobOutcome> => {
    try {
      return await withJobFolder(
        files,
        async (folder) => {
          const run = await runner.run(['meshops'], folder, timeoutMs, report, signal);
          return run.ok ? await resultOf(op, runner, folder, run) : failedJob(op, run, timeoutMs);
        },
        env,
      );
    } catch (error) {
      return failure('MESH_ENGINE_UNSUPPORTED', `llull-compute meshops ${op.op}: ${errorMessage(error)}`);
    }
  };

  return {
    name: 'native',
    capabilities: () => CAPABILITIES,
    run(input, op): MeshOpResult | MeshEngineFailure {
      if (op.op !== 'decimate' && op.op !== 'smooth' && op.op !== 'deviation' && op.op !== 'quad_remesh')
        return failure('MESH_ENGINE_UNSUPPORTED', `the native engine does not answer "${op.op}"`);
      if (op.op === 'decimate' || op.op === 'quad_remesh') {
        const problem = editableProblem(input.mesh, op.op === 'decimate' ? 'decimate_mesh' : 'quad_remesh');
        if (problem !== null) return problem;
      }
      const scope = currentScope();
      // this run already asked for a job: its input is a placeholder, so no job is packed or asked for
      if (scope?.deferring === true) return deferMeshOp(op.op);
      const files = {
        ...packMesh(input.mesh),
        ...(op.op === 'deviation' ? packMesh(op.other.mesh, '_b') : {}),
        'job.json': JSON.stringify({ op: op.op, params: jobParams(op) }),
      };
      const key = keyOf(files);
      // a finished result answers without a scope: a hit needs no job
      const held = scope?.lookup(key) ?? keptResult(key);
      if (held !== undefined) return held;
      if (scope === null)
        return failure(
          'MESH_ENGINE_NEEDS_HOST',
          `the native "${op.op}" runs through the host's async command path (resolveDeferred), not inline`,
        );
      if (scope.cancelled) return failure('MESH_CANCELLED', `the "${op.op}" job was cancelled`);
      scope.request({ key, op: op.op, heartbeatMs, start: (signal, report) => runJob(op, files, signal, report) });
      return deferMeshOp(op.op);
    },
  };
}
