/**
 * `cfd_solve` transport (12 CFD TECHNICAL_SPEC §4 / §6, M2): `buildFlowJob` (@aero) runs the preparation checks and exports `case.json` +
 * `surface.stl`; `llull-compute flow` runs the lattice-Boltzmann solve (progress per drag sample) and writes `result.json`, `surface.bin` and
 * the slices; the bundle becomes a `cfd_result` artifact in the store and `record_cfd_results` recomputes and records its summary. Without the
 * binary the tool refuses with CFD_SOLVER_MISSING (+ NATIVE_TOOL_MISSING install hint): there is no TypeScript solver.
 * The document is only ever changed by `record_cfd_results`.
 */

import { defaultContext } from '@core/commands/context';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@protocol/index';
import { buildFlowJob, cfdCaseOf, cfdSummary, flowResultArtifact, parseFlowResult, type FlowDevice, type FlowJob } from '@aero/index';
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
}

const failure = (code: string, message: string, ids: readonly string[], extra: Record<string, unknown> = {}): FeaToolResult => ({
  ...feaFailure(TOOL, code, message, ids),
  data: { code, ...extra },
});

/** Native failure -> the CFD_* code the agent sees (the job's own code stays in `data.nativeCode`). */
function cfdCode(run: JobRun): string {
  if (run.code === 'NATIVE_TIMEOUT') return 'CFD_TIMEOUT';
  if (run.code === 'NATIVE_TOOL_MISSING') return 'CFD_SOLVER_MISSING';
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

/** The native run: job folder, `llull-compute flow`, outputs read back (hash-checked) and turned into the artifact. */
async function solveNatively(job: FlowJob, caseId: string, seconds: number, deps: NativeDeps): Promise<Solved | FeaToolResult> {
  const sink = deps.onProgress;
  const outcome = await withJobFolder(
    { 'case.json': JSON.stringify(job.caseJson), 'surface.stl': Buffer.from(job.stl) },
    async (folder) => {
      const run = await deps.runner.run(
        ['flow'],
        folder,
        seconds * 1000,
        sink === undefined ? undefined : (event) => sink(progressLine(event)),
      );
      if (!run.ok) return { run, outputs: null };
      const slices = run.outputs.filter((entry) => /^slice-\d+\.bin$/.test(entry.path)).map((entry) => entry.path);
      const [result, surface, ...sliceBytes] = await Promise.all([
        readOutput(folder, run, 'result.json'),
        readOutput(folder, run, 'surface.bin'),
        ...slices.map((name) => readOutput(folder, run, name)),
      ]);
      return {
        run,
        outputs: { result, surface, slices: slices.map((name, index) => ({ name, bytes: new Uint8Array(sliceBytes[index] ?? []) })) },
      };
    },
    deps.env,
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in outcome) return failure('CFD_SOLVER_FAILED', `the job folder or its outputs failed: ${outcome.error}`, [caseId]);
  const { run, outputs } = outcome;
  if (outputs === null) {
    const code = cfdCode(run);
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
  const parsed = parseFlowResult(outputs.result.toString('utf8'));
  if (typeof parsed === 'string') return failure('CFD_SOLVER_FAILED', parsed, [caseId]);
  const artifact = flowResultArtifact(
    parsed,
    job,
    { surface: new Uint8Array(outputs.surface), slices: outputs.slices },
    await deps.runner.version(),
  );
  if (typeof artifact === 'string') return failure('CFD_SOLVER_FAILED', artifact, [caseId]);
  return { artifact, elapsedMs: run.elapsedMs, warnings: run.warnings };
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
  const built = buildFlowJob(doc, cfdCase, defaultContext().kernel, {
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
  const solved = await solveNatively(job, caseId, seconds, deps);
  if (!('artifact' in solved)) return solved;

  const { artifact } = solved;
  const resultsHash = deps.store.put(artifact);
  const summary = cfdSummary(cfdCase, artifact, resultsHash);
  const recorded = host.applyCommand('record_cfd_results', { caseId, resultsHash, summary });
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
