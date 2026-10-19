/**
 * `topology_solve` transport (PHY-17 RS-2, TECHNICAL_SPEC §4 / §13 / §14): `buildTopologyJob` (@cae) turns the study into a grid, masks, nodal loads
 * and fixed dofs; `llull-compute topopt` runs the SIMP loop (progress per iteration) and writes `field.bin` / `design.f64` / `result.json`; the field
 * becomes an `fe_topology` artifact in the store and `record_topology_result` recomputes and records its summary. Without the binary a small 2D job
 * (<= TS_REFERENCE_MAX_ELEMENTS voxels) runs the pure TypeScript reference instead (`solver.job: 'ts-reference'`); anything else is TOP_TOOL_MISSING.
 * The document is only ever changed by `record_topology_result`.
 */

import type { FeTopologyArtifact, TopologyHistoryRow, TopologyStudy } from '@core/model/topology';
import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@protocol/index';
import { isRecord } from '@lib/isRecord';
import { buildTopologyArtifact, buildTopologyJob, runTopologyReference, TS_REFERENCE_MAX_ELEMENTS, type TopologyJob } from '@cae/index';
import { topologySummary } from '@cae/topology/artifact';
import { findStudy } from '@cae/topology/model';
import { feaFailure } from '../fea/feaCommon';
import { f64Values, readOutput, withJobFolder, type JobRun } from './computeJob';
import { nativeInstallHint } from './nativeBinary';
import type { NativeDeps } from './fatigueField';
import { loadResume, saveResume, topologyJobFiles, type ResumeState, type TopologyDevice } from './topologyJobFiles';

const TOOL = 'topology_solve';
export const DEFAULT_TOPOLOGY_TIMEOUT_S = 1800;

export interface TopologySolveOptions {
  readonly timeoutS?: number;
  /** Continue the last finished run of the study (its design.f64) instead of starting from the uniform design. */
  readonly resumeFromLast?: boolean;
  readonly device?: TopologyDevice;
}

const failure = (code: string, message: string, ids: readonly string[], extra: Record<string, unknown> = {}): FeaToolResult => ({
  ...feaFailure(TOOL, code, message, ids),
  data: { code, ...extra },
});

/** The `result.json` fields the artifact needs, or an explanation. */
function parseResult(text: string, version: string): Parameters<typeof buildTopologyArtifact>[2] | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'result.json is not JSON';
  }
  if (!isRecord(value)) return 'result.json is not an object';
  const { compliance, perLoadCase, iterations, status, history, device, deterministic } = value;
  if (
    typeof compliance !== 'number' ||
    !isRecord(perLoadCase) ||
    typeof iterations !== 'number' ||
    (status !== 'converged' && status !== 'max_iterations') ||
    !Array.isArray(history) ||
    (device !== 'cpu' && device !== 'gpu') ||
    typeof deterministic !== 'boolean'
  )
    return 'result.json lacks compliance, perLoadCase, iterations, status, history, device or deterministic';
  return {
    compliance,
    perLoadCase: perLoadCase as Record<string, number>,
    iterations,
    status,
    history: history as TopologyHistoryRow[],
    device,
    deterministic,
    version,
  };
}

/** Native failure -> the TOP_* code the agent sees (the job's own code is kept in `data.nativeCode`). */
function topCode(run: JobRun): string {
  if (run.code === 'NATIVE_TIMEOUT') return 'TOP_SOLVER_TIMEOUT';
  if (run.code === 'NATIVE_TOOL_MISSING') return 'TOP_TOOL_MISSING';
  return run.code === 'TOP_GRID_TOO_LARGE' ? 'TOP_GRID_TOO_LARGE' : 'TOP_SOLVER_FAILED';
}

function missingTool(job: TopologyJob, studyId: string): FeaToolResult {
  const { nx, ny, nz } = job.grid;
  const reason =
    job.dimension === 3
      ? 'a 3D study needs the native solver'
      : `${nx * ny} voxels exceed the TypeScript reference cap of ${TS_REFERENCE_MAX_ELEMENTS}`;
  return failure(
    'TOP_TOOL_MISSING',
    `llull-compute is not installed and ${reason} (${nx} x ${ny}${job.dimension === 3 ? ` x ${nz}` : ''}). NATIVE_TOOL_MISSING: ${nativeInstallHint('llull-compute')}; or use a coarser 2D grid (voxel).`,
    [studyId],
    { nativeCode: 'NATIVE_TOOL_MISSING' },
  );
}

interface Solved {
  readonly artifact: FeTopologyArtifact;
  readonly elapsedMs: number;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly resumedFrom: number;
  readonly state: ResumeState | null;
}

/** One progress line; a resumed run continues the numbering (`done` iterations were run before, the cap is the study's total). */
const progressLine = (event: Readonly<Record<string, unknown>>, done: number): string => {
  const number = (key: string): string => (typeof event[key] === 'number' ? Number(event[key]).toPrecision(6) : '?');
  const count = (key: string): string => (typeof event[key] === 'number' ? String(Number(event[key]) + done) : '?');
  return `${TOOL}: iteration ${count('it')}/${count('total')} compliance ${number('compliance')} volume ${number('volume')} change ${number('change')}`;
};

/** The native run: job folder, `llull-compute topopt`, outputs read back (hash-checked). */
async function solveNatively(
  job: TopologyJob,
  doc: Parameters<typeof topologyJobFiles>[0],
  studyId: string,
  options: TopologySolveOptions,
  deps: NativeDeps,
  resume: ResumeState | null,
): Promise<Solved | FeaToolResult> {
  const seconds = Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, options.timeoutS ?? DEFAULT_TOPOLOGY_TIMEOUT_S));
  const files = topologyJobFiles(
    doc,
    job,
    options.device ?? 'cpu',
    resume === null
      ? undefined
      : {
          design: resume.design,
          ...(resume.displacements === undefined ? {} : { displacements: resume.displacements }),
          iterationsDone: resume.iterations,
        },
  );
  const sink = deps.onProgress;
  const outcome = await withJobFolder(
    files,
    async (folder) => {
      const run = await deps.runner.run(
        ['topopt'],
        folder,
        seconds * 1000,
        sink === undefined ? undefined : (event) => sink(progressLine(event, resume?.iterations ?? 0)),
      );
      if (!run.ok) return { run, outputs: null };
      const reported = run.outputs.some((entry) => entry.path === 'displacements.f64');
      const [field, design, result, displacements] = await Promise.all([
        readOutput(folder, run, 'field.bin'),
        readOutput(folder, run, 'design.f64'),
        readOutput(folder, run, 'result.json'),
        reported ? readOutput(folder, run, 'displacements.f64') : undefined,
      ]);
      return { run, outputs: { field, design, result, displacements } };
    },
    deps.env,
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in outcome) return failure('TOP_SOLVER_FAILED', `the job folder or its outputs failed: ${outcome.error}`, [studyId]);
  const { run } = outcome;
  const { outputs } = outcome;
  if (outputs === null) {
    const code = topCode(run);
    if (code === 'TOP_TOOL_MISSING') return missingTool(job, studyId);
    const hint =
      code === 'TOP_SOLVER_TIMEOUT'
        ? ` after ${seconds} s: the run is lost (no checkpoint is written on a kill); use a coarser voxel or a larger timeoutS. resumeFromLast continues a run that finished`
        : '';
    return failure(code, `${run.message ?? 'llull-compute failed'}${hint}. Last output:\n${run.log.slice(-2000)}`, [studyId], {
      nativeCode: run.code,
      log: run.log.slice(-4000),
    });
  }
  const parsed = parseResult(outputs.result.toString('utf8'), await deps.runner.version());
  if (typeof parsed === 'string') return failure('TOP_SOLVER_FAILED', parsed, [studyId]);
  const before = resume?.iterations ?? 0;
  const history = [...(resume?.history ?? []), ...parsed.history.map((row) => ({ ...row, it: row.it + before }))];
  const artifact = buildTopologyArtifact(job, outputs.field, { ...parsed, iterations: parsed.iterations + before, history }, 'topopt');
  if (typeof artifact === 'string') return failure('TOP_SOLVER_FAILED', artifact, [studyId]);
  const copy = new Uint8Array(outputs.design.length);
  copy.set(outputs.design);
  const displacements = outputs.displacements === undefined ? undefined : f64Values(outputs.displacements);
  return {
    artifact,
    elapsedMs: run.elapsedMs,
    warnings: run.warnings,
    resumedFrom: before,
    state: {
      design: new Float64Array(copy.buffer),
      ...(displacements === undefined ? {} : { displacements }),
      iterations: artifact.iterations,
      history,
    },
  };
}

/**
 * @failure unknown study -> TOP_STUDY_NOT_FOUND; job refusals -> their TOP_* code; no binary and not a small 2D grid -> TOP_TOOL_MISSING
 *   (+ NATIVE_TOOL_MISSING hint); native errors -> TOP_GRID_TOO_LARGE / TOP_SOLVER_FAILED, timeout -> TOP_SOLVER_TIMEOUT (data.nativeCode keeps the
 *   job's code); record refusals (TOP_RESULT_STALE, ...) -> their code from `record_topology_result`
 */
export async function runTopologySolve(
  studyId: string,
  options: TopologySolveOptions,
  host: FeaHost,
  deps: NativeDeps,
): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const found = findStudy(doc, studyId);
  if (found === undefined) return failure('TOP_STUDY_NOT_FOUND', `no topology study '${studyId}': create_topology_study first`, [studyId]);
  const study: TopologyStudy = found.study;
  const built = buildTopologyJob(doc, study);
  if (!built.ok) return failure(built.code, built.message, built.ids.length > 0 ? built.ids : [studyId]);
  const { job } = built;

  const native = deps.runner.binary !== null;
  const small = job.dimension === 2 && job.grid.nz === 1 && job.grid.nx * job.grid.ny <= TS_REFERENCE_MAX_ELEMENTS;
  if (!native && !small) return missingTool(job, studyId);

  let solved: Solved | FeaToolResult;
  let note = '';
  if (native) {
    const resume = options.resumeFromLast === true ? loadResume(deps.store.directory, studyId, job) : null;
    if (options.resumeFromLast === true && resume === null)
      note = ' (resumeFromLast: no saved run of this study for these inputs, started from the uniform design)';
    solved = await solveNatively(job, doc, studyId, options, deps, resume);
    if (
      !('artifact' in solved) &&
      solved.data !== undefined &&
      isRecord(solved.data) &&
      solved.data['code'] === 'TOP_TOOL_MISSING' &&
      small
    ) {
      solved = referenceRun(job, studyId);
    }
  } else {
    solved = referenceRun(job, studyId);
  }
  if (!('artifact' in solved)) return solved;

  const { artifact } = solved;
  const fieldHash = deps.store.put(artifact);
  if (solved.state !== null) saveResume(deps.store.directory, studyId, job, solved.state);
  const summary = topologySummary(doc, study, artifact, fieldHash);
  if (typeof summary === 'string') return failure('TOP_SUMMARY_MISMATCH', summary, [studyId, fieldHash]);
  const recorded = host.applyCommand('record_topology_result', { studyId, fieldHash, summary });
  const resumed = solved.resumedFrom > 0 ? ` resumed after ${solved.resumedFrom} iterations;` : '';
  const warnings = solved.warnings.map((warning) => `${warning.code}: ${warning.message}`).join('; ');
  return {
    summary: `${TOOL}: ${artifact.solver.job} ${artifact.solver.version} (${artifact.solver.device}${artifact.solver.deterministic ? ', deterministic' : ''}),${resumed} ${artifact.iterations} iterations in ${solved.elapsedMs} ms${note}${warnings === '' ? '' : ` [${warnings}]`}. ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      studyId,
      fieldHash,
      inputHash: artifact.inputHash,
      solver: artifact.solver,
      iterations: artifact.iterations,
      status: artifact.status,
      compliance: artifact.compliance,
      elapsedMs: solved.elapsedMs,
      ...(solved.resumedFrom > 0 ? { resumedFromIteration: solved.resumedFrom } : {}),
      ...(solved.warnings.length > 0 ? { warnings: solved.warnings } : {}),
      record: recorded.data,
    },
  };
}

function referenceRun(job: TopologyJob, studyId: string): Solved | FeaToolResult {
  const started = Date.now();
  const artifact = runTopologyReference(job);
  if (typeof artifact === 'string') return failure('TOP_SOLVER_FAILED', artifact, [studyId]);
  return { artifact, elapsedMs: Date.now() - started, warnings: [], resumedFrom: 0, state: null };
}
