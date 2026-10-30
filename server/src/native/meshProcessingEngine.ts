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
import { MESH_ENGINE_NEEDS_HOST, deferMeshOp } from '@core/geometry/mesh/engine';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { isMeshAnalysis } from '@core/geometry/mesh/analysis';
import {
  ANALYZE_DESCRIPTION,
  DECIMATE_DESCRIPTION,
  FILL_HOLES_DESCRIPTION,
  QUAD_DESCRIPTION,
  REMESH_DESCRIPTION,
  editableProblem,
  repairDescription,
  smoothDescription,
} from '@core/geometry/mesh/editable';
import { isFillReport, isRepairReport } from '@core/geometry/mesh/reportChecks';
import { isDeviationSummary, type DeviationSummary } from '@core/geometry/mesh/deviation';
import {
  MESH_TS_TRIANGLE_CAP,
  type MeshEngineFailure,
  type MeshOp,
  type MeshOpName,
  type MeshOpResult,
  type MeshProcessingEngine,
} from '@core/geometry/mesh/engineTypes';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { positiveInteger } from '../env';
import { createComputeRunner, readOutput, withJobFolder, type ComputeRunner, type JobRun } from './computeJob';
import type { ResolveMemo } from '@core/commands/resolveMemo';
import { configureResultCache, currentScope, keptResult, type JobOutcome } from './deferredRun';
import { nativeBinaryPath } from './nativeBinary';

const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_HEARTBEAT_MS = 5000;
/** Named guard: input triangles above which quad_remesh refuses (QuadriFlow memory and time grow with the mesh; decimate_mesh first). */
const QUAD_REMESH_TRIANGLE_CAP = 500_000;
/** Named guard: input triangles above which remesh refuses (the working mesh keeps per-vertex face lists: about 1 GB at this size; decimate_mesh first). */
const REMESH_TRIANGLE_CAP = 2_000_000;
/** Named guard: input triangles above which repair and fill_holes refuse (the working mesh of the hole filler keeps per-vertex face lists; the edge sort of orient holds 3 entries per triangle). */
const REPAIR_TRIANGLE_CAP = 4_000_000;
/** The vendored QuadriFlow commit (solver/crates/llull-quadflow/vendor/README.md), recorded in the provenance of every result with the platform: the float code differs between compilers, so a result is reproducible per platform build. */
const QUADRIFLOW_LIBRARY = ` + QuadriFlow@810b7a0 (${process.platform}-${process.arch})`;

const CAPABILITIES: ReadonlyMap<MeshOpName, number> = new Map<MeshOpName, number>([
  ['decimate', Infinity],
  ['smooth', Infinity],
  ['remesh', REMESH_TRIANGLE_CAP],
  ['analyze', Infinity],
  ['repair', REPAIR_TRIANGLE_CAP],
  ['fill_holes', REPAIR_TRIANGLE_CAP],
  ['deviation', Infinity],
  ['quad_remesh', QUAD_REMESH_TRIANGLE_CAP],
]);

/** The ops this engine answers (the keys of CAPABILITIES). */
const NATIVE_OPS: ReadonlySet<MeshOpName> = new Set(CAPABILITIES.keys());

function isNativeOp(op: MeshOp): op is NativeOp {
  return NATIVE_OPS.has(op.op);
}

/** The command name the editable-mesh refusals mention. */
const OP_COMMAND = { decimate: 'decimate_mesh', remesh: 'remesh_mesh', quad_remesh: 'quad_remesh' } as const;

/**
 * Input triangles above which the native engine is asked before the TypeScript one (TECHNICAL_SPEC 13.12.4): the smallest sizes at which a cold job
 * (spawn, files, JSON; 25 to 45 ms on the reference machine) is no slower than the in-process answer, with a margin. `quad_remesh` has no TypeScript twin.
 */
const PREFERRED_ABOVE: ReadonlyMap<MeshOpName, number> = new Map<MeshOpName, number>([
  ['decimate', 1_000],
  ['remesh', 2_000],
  ['deviation', 3_000],
  ['smooth', 10_000],
  ['analyze', 15_000],
  ['repair', 50_000],
  ['fill_holes', 30_000],
]);

/** The refusals of `fill_holes` a job may hand to the command as they are (`fill_mesh_holes` documents them); any other code is `MESH_ENGINE_UNSUPPORTED`. */
const FILL_REFUSALS: ReadonlySet<string> = new Set([
  'MESH_HOLE_NOT_FOUND',
  'MESH_HOLE_TOO_LARGE',
  'MESH_HOLE_NON_SIMPLE',
  'MESH_HOLE_NO_TRIANGULATION',
]);

const failure = (code: string, message: string): MeshEngineFailure => ({ code, message });

const regionOf = (region: { readonly center: readonly number[]; readonly radius: number } | undefined): Record<string, unknown> =>
  region === undefined ? {} : { center: [...region.center], radius: region.radius };

type NativeOp = Extract<
  MeshOp,
  { op: 'decimate' | 'smooth' | 'remesh' | 'analyze' | 'repair' | 'fill_holes' | 'deviation' | 'quad_remesh' }
>;

/** `deviationSamples` of job.json: the job also measures the deviation of its result from its input (the Rust side skips it when absent). */
function deviationRequest(op: NativeOp): { deviationSamples?: number } {
  return op.op !== 'deviation' && op.op !== 'analyze' && op.withDeviation !== undefined ? { deviationSamples: op.withDeviation } : {};
}

/** The job parameters (JSON) of a supported op; `Math.cos` of the feature angle is computed here, as the TypeScript engine does. */
function jobParams(op: NativeOp): Record<string, unknown> {
  if (op.op === 'deviation') return { maxSamples: op.maxSamples };
  if (op.op === 'analyze') return { maxListed: op.maxListed, weldTolerance: op.weldTolerance, selfIntersections: op.selfIntersections };
  if (op.op === 'repair')
    return {
      mode: op.mode,
      weldTolerance: op.weldTolerance,
      maxGap: op.maxGap,
      maxBoundaryEdges: op.maxBoundaryEdges,
      ...(op.smallComponents !== undefined ? { smallComponents: op.smallComponents } : {}),
    };
  if (op.op === 'fill_holes')
    return {
      select: op.select,
      maxBoundaryEdges: op.maxBoundaryEdges,
      fairing: op.fairing,
      refine: op.refine,
      ...(op.alpha !== undefined ? { alpha: op.alpha } : {}),
    };
  if (op.op === 'quad_remesh')
    return { targetFaces: op.targetQuads, adaptive: op.adaptive, ...(op.hardEdgeRad !== undefined ? { hardEdgeRad: op.hardEdgeRad } : {}) };
  if (op.op === 'remesh')
    return {
      ...(op.targetEdge !== undefined ? { targetEdge: op.targetEdge } : {}),
      ...(op.minEdge !== undefined ? { minEdge: op.minEdge } : {}),
      ...(op.maxEdge !== undefined ? { maxEdge: op.maxEdge } : {}),
      ...(op.approxError !== undefined ? { approxError: op.approxError } : {}),
      iterations: op.iterations,
      featureAngleRad: op.featureAngleRad,
      preserveBoundary: op.preserveBoundary,
      project: op.project,
      ...(op.region !== undefined ? { region: regionOf(op.region) } : {}),
      ...(op.maxTriangles !== undefined ? { maxTriangles: op.maxTriangles } : {}),
    };
  if (op.op === 'decimate')
    return {
      preserveBoundary: op.preserveBoundary,
      ...(op.targetTriangles !== undefined ? { targetTriangles: op.targetTriangles } : {}),
      ...(op.maxDeviation !== undefined ? { maxDeviation: op.maxDeviation } : {}),
      ...(op.featureAngleRad !== undefined ? { featureAngleRad: op.featureAngleRad } : {}),
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

/** One file of a job folder with the SHA-256 of its bytes (computed once: the mesh files of a big job are megabytes). */
interface JobFile {
  readonly name: string;
  readonly data: Buffer | string;
  readonly digest: string;
}

const jobFile = (name: string, data: Buffer | string): JobFile => ({ name, data, digest: createHash('sha256').update(data).digest('hex') });

function packMesh(mesh: MeshData, suffix = ''): readonly JobFile[] {
  const positions = Buffer.allocUnsafe(mesh.positions.length * 8);
  mesh.positions.forEach((value, i) => positions.writeDoubleLE(value, i * 8));
  const indices = Buffer.allocUnsafe(mesh.indices.length * 4);
  mesh.indices.forEach((value, i) => indices.writeUInt32LE(value, i * 4));
  return [jobFile(`positions${suffix}.f64`, positions), jobFile(`indices${suffix}.u32`, indices)];
}

/** The packed files of `mesh`: kept in the resolve memo by the mesh object, so the next run of the command (which gets the same object) packs and hashes nothing. */
function packedMesh(mesh: MeshData, memo: ResolveMemo | undefined): readonly JobFile[] {
  if (memo === undefined) return packMesh(mesh);
  return memo.once(
    mesh,
    'native:pack',
    () => packMesh(mesh),
    (files) => files.reduce((sum, file) => sum + file.data.length / 8, 0),
  );
}

/** The refusal `editableProblem` gives `mesh` for command `label`, or null; kept in the resolve memo like `packedMesh`. */
function editableProblemOf(mesh: MeshData, label: string, memo: ResolveMemo | undefined): MeshEngineFailure | null {
  return memo === undefined
    ? editableProblem(mesh, label)
    : memo.once(mesh, `native:editable:${label}`, () => editableProblem(mesh, label));
}

function unpackMesh(positions: Buffer, indices: Buffer): MeshData {
  const outPositions = new Array<number>(positions.length / 8);
  for (let i = 0; i < outPositions.length; i++) outPositions[i] = positions.readDoubleLE(i * 8);
  const outIndices = new Array<number>(indices.length / 4);
  for (let i = 0; i < outIndices.length; i++) outIndices[i] = indices.readUInt32LE(i * 4);
  return { positions: outPositions, indices: outIndices };
}

/** Why `mesh` cannot be a triangle mesh (positions not whole xyz triples, indices not whole triangles, an index past the vertices, a coordinate that is not finite), or null. */
export function meshProblem(mesh: MeshData): string | null {
  const vertices = mesh.positions.length / 3;
  if (!Number.isInteger(vertices)) return `${mesh.positions.length} coordinates are not whole xyz triples`;
  if (mesh.indices.length % 3 !== 0) return `${mesh.indices.length} indices are not whole triangles`;
  if (!mesh.positions.every(Number.isFinite)) return 'a coordinate is not a finite number';
  const past = mesh.indices.find((index) => index >= vertices);
  return past === undefined ? null : `the index ${past} is not below the ${vertices} vertices`;
}

/** Content key of a job: the op, its parameters and the mesh bytes (through the digests of its files). */
function keyOf(files: readonly JobFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1)))
    hash.update(file.name).update('\0').update(file.digest).update('\0');
  return hash.digest('hex');
}

/** The failure of a job that did not finish ok. */
function failedJob(op: NativeOp, run: JobRun, timeoutMs: number): MeshEngineFailure {
  if (run.code === 'NATIVE_TIMEOUT') return failure('MESH_TIMEOUT', `llull-compute meshops ${op.op} exceeded ${timeoutMs / 1000} s`);
  if (run.code === 'NATIVE_CANCELLED') return failure('MESH_CANCELLED', `llull-compute meshops ${op.op} was cancelled`);
  if (op.op === 'fill_holes' && run.code !== undefined && FILL_REFUSALS.has(run.code)) return failure(run.code, run.message ?? run.code);
  if (op.op === 'fill_holes' && run.code === 'HOLE_NEAR_NOT_FOUND') {
    // the job names the point by its position in the list; the text of a point is the JavaScript one
    const point = typeof op.select === 'object' && 'near' in op.select ? op.select.near[Number(run.message)] : undefined;
    if (point !== undefined) return failure('MESH_HOLE_NOT_FOUND', `no boundary loop near [${point.join(', ')}]: the mesh has none`);
  }
  if (run.code === 'REMESH_TOO_LARGE') return failure('MESH_REMESH_RESULT_TOO_LARGE', run.message ?? 'the remeshed surface is too large');
  if (op.op === 'quad_remesh')
    return failure('MESH_QUAD_REMESH_FAILED', `QuadriFlow: ${run.code ?? 'failed'} — ${run.message ?? ''}`.trim());
  return failure('MESH_ENGINE_UNSUPPORTED', `llull-compute meshops ${op.op}: ${run.code ?? 'failed'} — ${run.message ?? ''}`.trim());
}

/** `{ deviation }` when `value` (parsed JSON of the job) is a well-formed summary; otherwise nothing, and the caller measures separately or reports no deviation. */
export function deviationFrom(value: unknown): { deviation?: DeviationSummary } {
  return isDeviationSummary(value) ? { deviation: value } : {};
}

/** Read the outputs of a finished job into the engine's result. */
async function resultOf(op: NativeOp, runner: ComputeRunner, folder: string, run: JobRun): Promise<MeshOpResult | MeshEngineFailure> {
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
      ...deviationFrom(report),
      report: {},
      provenance: provenance(
        'closest-surface distance from vertices and triangle centroids, both ways',
        'bounding-volume closest point (Ericson 5.1.5)',
      ),
    };
  if (op.op === 'analyze') {
    const analysis = isRecord(summary) ? summary['analysis'] : undefined;
    if (!isMeshAnalysis(analysis))
      return failure('MESH_ENGINE_UNSUPPORTED', 'llull-compute meshops analyze: the job returned no well-formed analysis');
    return { analysis, report, provenance: provenance(ANALYZE_DESCRIPTION.algorithm, ANALYZE_DESCRIPTION.reference) };
  }
  const mesh = unpackMesh(await readOutput(folder, run, 'result_positions.f64'), await readOutput(folder, run, 'result_indices.u32'));
  const malformed = op.op === 'quad_remesh' ? null : meshProblem(mesh);
  if (malformed !== null)
    return failure('MESH_ENGINE_UNSUPPORTED', `llull-compute meshops ${op.op}: the result mesh is malformed: ${malformed}`);
  // measured by the same job when the op asked for it (`withDeviation`)
  const measured = deviationFrom(isRecord(summary) ? summary['deviation'] : undefined);
  if (op.op === 'quad_remesh')
    return {
      quads: { positions: mesh.positions, quads: mesh.indices },
      report,
      ...measured,
      provenance: provenance(QUAD_DESCRIPTION.algorithm, QUAD_DESCRIPTION.reference, QUADRIFLOW_LIBRARY),
    };
  if ((op.op === 'repair' && !isRepairReport(report, op.mode)) || (op.op === 'fill_holes' && !isFillReport(report, op.fairing)))
    return failure('MESH_ENGINE_UNSUPPORTED', `llull-compute meshops ${op.op}: the job returned a malformed report`);
  const description =
    op.op === 'repair'
      ? repairDescription(op.mode)
      : op.op === 'fill_holes'
        ? FILL_HOLES_DESCRIPTION
        : op.op === 'decimate'
          ? DECIMATE_DESCRIPTION
          : op.op === 'remesh'
            ? REMESH_DESCRIPTION
            : smoothDescription(op.method === 'taubin');
  return { mesh, report, ...measured, provenance: provenance(description.algorithm, description.reference) };
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
    files: readonly JobFile[],
    signal: AbortSignal,
    report: (event: Readonly<Record<string, unknown>>) => void,
  ): Promise<JobOutcome> => {
    try {
      return await withJobFolder(
        Object.fromEntries(files.map((file) => [file.name, file.data])),
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
    preferredAbove: () => PREFERRED_ABOVE,
    run(input, op): MeshOpResult | MeshEngineFailure {
      if (!isNativeOp(op)) return failure('MESH_ENGINE_UNSUPPORTED', `the native engine does not answer "${op.op}"`);
      if (op.op === 'analyze' && op.weldTolerance !== 0)
        return failure('MESH_ENGINE_UNSUPPORTED', 'the native analysis welds exact duplicates only');
      const triangles = input.mesh.indices.length / 3;
      // the pair search is not ported (slice 4): the TypeScript engine answers up to its cap, above it the command is refused by name
      if (op.op === 'analyze' && op.selfIntersections)
        return triangles <= MESH_TS_TRIANGLE_CAP
          ? failure('MESH_ENGINE_UNSUPPORTED', 'the native analysis does not search self-intersections; the TypeScript engine does')
          : failure(
              'MESH_ENGINE_CAP_EXCEEDED',
              `the self-intersection search is limited to ${MESH_TS_TRIANGLE_CAP} triangles: pass selfIntersections false for ${triangles}`,
            );
      const scope = currentScope();
      const memo = scope?.memo;
      if (op.op === 'decimate' || op.op === 'remesh' || op.op === 'quad_remesh') {
        const problem = editableProblemOf(input.mesh, OP_COMMAND[op.op], memo);
        if (problem !== null) return problem;
      }
      // this run already asked for a job: its input is a placeholder, so no job is packed or asked for
      if (scope?.deferring === true) return deferMeshOp(op.op);
      const files: readonly JobFile[] = [
        ...packedMesh(input.mesh, memo),
        ...(op.op === 'deviation' ? packMesh(op.other.mesh, '_b') : []),
        jobFile('job.json', JSON.stringify({ op: op.op, params: jobParams(op), ...deviationRequest(op) })),
      ];
      const key = keyOf(files);
      // a finished result answers without a scope: a hit needs no job
      const held = scope?.lookup(key) ?? keptResult(key);
      if (held !== undefined) return held;
      if (scope === null)
        return failure(
          MESH_ENGINE_NEEDS_HOST,
          `the native "${op.op}" runs through the host's async command path (resolveDeferred), not inline`,
        );
      // the TypeScript engine takes it only if both meshes of a deviation fit its cap
      const largest = op.op === 'deviation' ? Math.max(triangles, op.other.mesh.indices.length / 3) : triangles;
      // a held result answers whatever the budget; with the budget spent, leave what the TypeScript engine can take to it (the composite falls through), so a long plan of small steps still runs
      if (scope?.budgetSpent === true && (tsMeshEngine.capabilities().get(op.op) ?? 0) >= largest)
        return failure(
          MESH_ENGINE_NEEDS_HOST,
          `the job budget of this command is spent: "${op.op}" on ${triangles} triangles is left to the TypeScript engine`,
        );
      if (scope.cancelled) return failure('MESH_CANCELLED', `the "${op.op}" job was cancelled`);
      scope.request({ key, op: op.op, heartbeatMs, start: (signal, report) => runJob(op, files, signal, report) });
      return deferMeshOp(op.op);
    },
  };
}
