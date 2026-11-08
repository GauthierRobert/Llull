/**
 * `cfd_solve` transport (12 CFD TECHNICAL_SPEC §4 / §6, M2): `buildFlowJob` (@aero) runs the preparation checks and exports `case.json` +
 * `surface.stl`; `llull-compute flow` runs the lattice-Boltzmann solve (progress per drag sample) and writes `result.json`, `surface.bin` and
 * the slices; the bundle becomes a `cfd_result` artifact in the store and `record_cfd_results` recomputes and records its summary. Without the
 * binary the tool refuses with CFD_SOLVER_MISSING (+ NATIVE_TOOL_MISSING install hint): there is no TypeScript solver.
 * The document is only ever changed by `record_cfd_results`. M3a: the run's `field.bin` is kept content-addressed (`fileStore.ts`) and bound by
 * hash in the bundle (the queries read it); identical concurrent solves share one run (`../native/sharedRun.ts`), each caller keeps its own signal,
 * and `cfd_stop` kills the runs of a case (process tree) — a cancelled or stopped solve records nothing.
 */

import { defaultContext } from '@core/commands/context';
import { withFullResolution } from '@core/geometry/entityTriangles';
import { defaultMeshAssetStore } from '../meshAssets/store';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@protocol/index';
import {
  buildFlowJob,
  cfdCaseOf,
  cfdSummary,
  FIELD_HEADER_BYTES,
  flowFieldHeader,
  flowResultArtifact,
  parseFlowResult,
  type FlowDevice,
  type FlowJob,
} from '@aero/index';
import { canonicalJson } from '@lib/canonicalJson';
import { errorMessage } from '@lib/errorMessage';
import { sha256Hex } from '../sha256';
import { cfdFileStore, hashFile, readHead, type StoredFile } from './fileStore';
import { createSharedRuns, type RunInfo } from '../native/sharedRun';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { feaFailure } from '../fea/feaCommon';
import { readOutput, withJobFolder, type JobRun } from '../native/computeJob';
import type { NativeDeps } from '../native/fatigueField';
import { nativeInstallHint } from '../native/nativeBinary';

const TOOL = 'cfd_solve';
export const DEFAULT_CFD_TIMEOUT_S = 3600;

export interface CfdSolveOptions {
  readonly timeoutS?: number;
  readonly device?: FlowDevice;
  readonly deviceMemoryBytes?: number;
  readonly maxSteps?: number;
  readonly latticeMach?: number;
  readonly les?: boolean;
  /** The caller's own cancellation (CLI Ctrl-C, a closed request): it stops waiting; the run dies when no other caller waits for it. */
  readonly signal?: AbortSignal;
}

const failure = (code: string, message: string, ids: readonly string[], extra: Record<string, unknown> = {}): FeaToolResult => ({
  ...feaFailure(TOOL, code, message, ids),
  data: { code, ...extra },
});

/** Native failure -> the CFD_* code the agent sees (the job's own code stays in `data.nativeCode`). */
function cfdCode(run: JobRun): string {
  if (run.code === 'NATIVE_TIMEOUT') return 'CFD_TIMEOUT';
  if (run.code === 'NATIVE_TOOL_MISSING') return 'CFD_SOLVER_MISSING';
  if (run.code === 'NATIVE_CANCELLED') return 'CFD_CANCELLED';
  return run.code !== undefined && run.code.startsWith('CFD_') ? run.code : 'CFD_SOLVER_FAILED';
}

const missingTool = (caseId: string): FeaToolResult =>
  failure(
    'CFD_SOLVER_MISSING',
    `llull-compute is not installed: cfd_solve has no TypeScript solver. NATIVE_TOOL_MISSING: ${nativeInstallHint('llull-compute')}.`,
    [caseId],
    { nativeCode: 'NATIVE_TOOL_MISSING' },
  );

const number = (value: unknown, digits = 4): string => (typeof value === 'number' ? value.toPrecision(digits) : '?');

const progressLine = (event: Readonly<Record<string, unknown>>): string =>
  `${TOOL}: step ${String(event['step'])}/${String(event['total'])} drag ${number(event['dragN'])} N Cd ${number(event['cd'])} (${String(event['phase'])}` +
  (typeof event['change'] === 'number' ? `, change ${event['change'].toExponential(2)}` : '') +
  ')';

interface Solved {
  readonly artifact: CfdResultArtifact;
  readonly elapsedMs: number;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/**
 * Checks `field.bin` of a finished run (reported by the job, its header on the grid of result.json, its size the one the header declares,
 * its streamed hash the reported one) and keeps it in the CFD file store; a string says what is wrong (nothing is kept then).
 */
async function keepField(folder: string, run: JobRun, resultText: Buffer, storeDirectory: string): Promise<StoredFile | string> {
  const reported = run.outputs.find((entry) => entry.path === 'field.bin');
  if (reported === undefined) return 'llull-compute did not report output field.bin';
  const file = path.join(folder, 'field.bin');
  const header = flowFieldHeader(new Uint8Array(await readHead(file, FIELD_HEADER_BYTES)), (await stat(file)).size);
  if (typeof header === 'string') return header;
  const parsed = parseFlowResult(resultText.toString('utf8'));
  if (typeof parsed === 'string') return parsed;
  const { grid } = parsed;
  const onGrid =
    header.nx === grid.nx &&
    header.ny === grid.ny &&
    header.nz === grid.nz &&
    header.cellM === grid.cellM &&
    header.originM.every((value, axis) => value === grid.originM[axis]);
  if (!onGrid) return `field.bin (${header.nx} x ${header.ny} x ${header.nz}) is not on the grid of result.json`;
  // One stream pass: hash, compare with the job's report, and only then copy (a rejected multi-GB field leaves nothing behind).
  const hashed = await hashFile(file);
  if (hashed.sha256 !== reported.sha256) return `field.bin hashes to ${hashed.sha256}, the job reported ${reported.sha256}`;
  return cfdFileStore(storeDirectory).putFile(file, hashed);
}

/** The native run: job folder, `llull-compute flow`, outputs read back (hash-checked) and turned into the artifact. */
async function solveNatively(
  job: FlowJob,
  caseId: string,
  seconds: number,
  deps: NativeDeps,
  signal: AbortSignal,
  sink: (line: string) => void,
): Promise<Solved | FeaToolResult> {
  const outcome = await withJobFolder(
    { 'case.json': JSON.stringify(job.caseJson), 'surface.stl': Buffer.from(job.stl) },
    async (folder) => {
      const run = await deps.runner.run(['flow'], folder, seconds * 1000, (event) => sink(progressLine(event)), signal);
      if (!run.ok) return { run, outputs: null };
      const slices = run.outputs.filter((entry) => /^slice-\d+\.bin$/.test(entry.path)).map((entry) => entry.path);
      const [result, surface, ...sliceBytes] = await Promise.all([
        readOutput(folder, run, 'result.json'),
        readOutput(folder, run, 'surface.bin'),
        ...slices.map((name) => readOutput(folder, run, name)),
      ]);
      // field.bin can exceed one Buffer: checked by its header and size, hashed by stream while it is stored (never read whole).
      const field = await keepField(folder, run, result, deps.store.directory);
      return {
        run,
        outputs: {
          result,
          surface,
          field,
          slices: slices.map((name, index) => ({ name, bytes: new Uint8Array(sliceBytes[index] ?? []) })),
        },
      };
    },
    deps.env,
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in outcome) return failure('CFD_SOLVER_FAILED', `the job folder or its outputs failed: ${outcome.error}`, [caseId]);
  const { run, outputs } = outcome;
  if (outputs === null) {
    const code = cfdCode(run);
    if (code === 'CFD_CANCELLED')
      return failure(code, 'the solve was cancelled: the process tree was killed and nothing was recorded', [caseId]);
    if (code === 'CFD_SOLVER_MISSING') return missingTool(caseId);
    const hint =
      code === 'CFD_TIMEOUT'
        ? ` after ${seconds} s: the run is lost (no checkpoint is written on a kill); coarsen the grid, lower maxSteps or raise timeoutS`
        : '';
    return failure(code, `${run.message ?? 'llull-compute failed'}${hint}. Last output:\n${run.log.slice(-2000)}`, [caseId], {
      nativeCode: run.code,
      log: run.log.slice(-4000),
    });
  }
  if (typeof outputs.field === 'string') return failure('CFD_SOLVER_FAILED', outputs.field, [caseId]);
  const parsed = parseFlowResult(outputs.result.toString('utf8'));
  if (typeof parsed === 'string') return failure('CFD_SOLVER_FAILED', parsed, [caseId]);
  const artifact = flowResultArtifact(
    parsed,
    job,
    { surface: new Uint8Array(outputs.surface), slices: outputs.slices, field: outputs.field },
    await deps.runner.version(),
  );
  if (typeof artifact === 'string') return failure('CFD_SOLVER_FAILED', artifact, [caseId]);
  return { artifact, elapsedMs: run.elapsedMs, warnings: run.warnings };
}

interface SolveMeta {
  readonly caseId: string;
}

interface RunningSolve {
  readonly caseId: string;
  readonly key: string;
  readonly startedAt: number;
  readonly waiters: number;
}

const solves = createSharedRuns<Solved | FeaToolResult, string, SolveMeta>();

const runningSolve = (run: RunInfo<SolveMeta>): RunningSolve => ({
  caseId: run.meta.caseId,
  key: run.key,
  startedAt: run.startedAt,
  waiters: run.waiters,
});

/** @internal tests only: stop every running solve (a failed test must not leave a run behind for the next one). */
export function _stopAllCfdSolves(): number {
  return solves.stop(() => true).length;
}

/** Key of a native run: the result store it fills and every byte of its job (identical solves into one store share one run). */
const runKey = (job: FlowJob, store: string): string =>
  sha256Hex(Buffer.concat([Buffer.from(store), Buffer.from([0]), Buffer.from(canonicalJson(job.caseJson)), Buffer.from(job.stl)]));

/**
 * `cfd_stop`: kills the running solves of `caseId` in this host process (the backend for `--app`); their callers get CFD_CANCELLED and
 * nothing is recorded.
 * @failure no solve of the case is running here -> CFD_NOT_RUNNING (nothing changes)
 */
export function runCfdStop(caseId: string): FeaToolResult {
  const stopped = solves.stop((meta) => meta.caseId === caseId).map(runningSolve);
  if (stopped.length === 0) {
    const others = solves.list().map(runningSolve);
    return failure(
      'CFD_NOT_RUNNING',
      `no solve of '${caseId}' is running in this host${others.length === 0 ? '' : ` (running: ${[...new Set(others.map((entry) => entry.caseId))].join(', ')})`}`,
      [caseId],
      { running: others },
    );
  }
  const waiters = stopped.reduce((sum, entry) => sum + entry.waiters, 0);
  return {
    summary: `cfd_stop: stopped ${stopped.length} running solve(s) of ${caseId} (process tree killed, ${waiters} waiting caller(s) answered CFD_CANCELLED); nothing was recorded.`,
    affected: [],
    isError: false,
    data: { caseId, stopped },
  };
}

/**
 * @failure unknown case -> CFD_CASE_NOT_FOUND; preparation fail rows -> their code (CFD_GEOMETRY_NOT_WATERTIGHT, ...); compressible case ->
 *   CFD_REGIME_MISMATCH; estimate above deviceMemoryBytes -> CFD_MEMORY_EXCEEDED (nothing allocated); no binary -> CFD_SOLVER_MISSING (+ hint);
 *   native errors -> their CFD_* code or CFD_SOLVER_FAILED, timeout -> CFD_TIMEOUT (data.nativeCode keeps the job's code); record refusals
 *   (CFD_INPUT_STALE, ...) -> their code from `record_cfd_results`. A step-limited run is recorded (converged false) with the warning CFD_NOT_CONVERGED.
 */
export async function runCfdSolve(caseId: string, options: CfdSolveOptions, host: FeaHost, deps: NativeDeps): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const cfdCase = cfdCaseOf(doc, caseId);
  if (cfdCase === undefined) return failure('CFD_CASE_NOT_FOUND', `no flow case '${caseId}': create_cfd_case first`, [caseId]);
  if (options.maxSteps !== undefined && !(Number.isInteger(options.maxSteps) && options.maxSteps >= 1))
    return failure('CFD_PARAM_INVALID', `maxSteps must be an integer >= 1, got ${options.maxSteps}`, [caseId]);
  if (options.latticeMach !== undefined && !(options.latticeMach > 0 && options.latticeMach <= 0.3))
    return failure('CFD_PARAM_INVALID', `latticeMach must be in (0, 0.3], got ${options.latticeMach}`, [caseId]);
  // The job reads triangles: hand it the stored meshes of asset-backed bodies, not their display level of detail (it refuses what it cannot get).
  const built = buildFlowJob(withFullResolution(doc, cfdCase.entityIds, defaultMeshAssetStore()), cfdCase, defaultContext().kernel, {
    device: options.device,
    maxSteps: options.maxSteps,
    latticeMach: options.latticeMach,
    les: options.les,
    deviceMemoryBytes: options.deviceMemoryBytes,
  });
  if (!built.ok) return failure(built.code, built.message, built.ids, { checks: built.checks });
  const { job } = built;
  if (deps.runner.binary === null) return missingTool(caseId);
  const seconds = Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, options.timeoutS ?? DEFAULT_CFD_TIMEOUT_S));
  const joined = await solves.join(
    runKey(job, deps.store.directory),
    { caseId },
    (signal, progress) => solveNatively(job, caseId, seconds, deps, signal, progress),
    { signal: options.signal, onProgress: deps.onProgress },
  );
  if (joined.kind === 'failed')
    return failure('CFD_SOLVER_FAILED', `the solve of '${caseId}' failed in the host: ${joined.error}; nothing was recorded`, [caseId]);
  if (joined.kind !== 'done')
    return failure(
      'CFD_CANCELLED',
      joined.kind === 'stopped'
        ? `the solve of '${caseId}' was stopped by cfd_stop: the process tree was killed and nothing was recorded`
        : `this caller stopped waiting for the solve of '${caseId}': nothing was recorded (the run goes on only while another caller waits)`,
      [caseId],
    );
  const solved = joined.value;
  if (!('artifact' in solved)) return solved;

  const { artifact } = solved;
  let resultsHash: string;
  try {
    resultsHash = deps.store.put(artifact);
  } catch (error) {
    return failure('CFD_SOLVER_FAILED', `the result bundle could not be stored: ${errorMessage(error)}; nothing was recorded`, [caseId]);
  }
  const summary = cfdSummary(cfdCase, artifact, resultsHash);
  const current = host.getDoc().cfd?.results[caseId];
  // A concurrent caller of the same run may have recorded it already: recording the same summary again would only add a history step.
  const recorded =
    current !== undefined && canonicalJson(current) === canonicalJson(summary)
      ? {
          summary: `record_cfd_results: ${caseId} result ${resultsHash.slice(0, 12)} already recorded (a concurrent caller of the same run).`,
          affected: [caseId],
          isError: false,
        }
      : host.applyCommand('record_cfd_results', { caseId, resultsHash, summary });
  const warnings = [
    ...solved.warnings,
    ...artifact.warnings.filter((entry) => !solved.warnings.some((seen) => seen.code === entry.code)),
    ...(artifact.converged
      ? []
      : [{ code: 'CFD_NOT_CONVERGED', message: `the step limit (${artifact.steps}) was reached before the drag settled` }]),
  ];
  const notes = warnings.map((entry) => `${entry.code}: ${entry.message}`).join('; ');
  return {
    summary:
      `${TOOL}: ${artifact.solver} ${artifact.solverVersion} (${artifact.device} ${artifact.precision}${artifact.deterministic ? ', deterministic' : ''}` +
      `${artifact.adapter === undefined ? '' : `, ${artifact.adapter}`}), ${artifact.steps} steps in ${solved.elapsedMs} ms, ${job.triangles} surface triangles` +
      (notes === '' ? '' : ` [${notes}]`) +
      `. ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      caseId,
      resultsHash,
      caseHash: artifact.caseHash,
      geometryHash: artifact.geometryHash,
      converged: artifact.converged,
      steps: artifact.steps,
      device: artifact.device,
      precision: artifact.precision,
      deterministic: artifact.deterministic,
      ...(artifact.adapter === undefined ? {} : { adapter: artifact.adapter }),
      elapsedMs: solved.elapsedMs,
      forces: summary.forces,
      grid: artifact.grid,
      lattice: artifact.lattice,
      defaults: job.defaults,
      notes: job.notes,
      ...(warnings.length > 0 ? { warnings } : {}),
      record: recorded.data,
    },
  };
}
