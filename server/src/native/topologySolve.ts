/**
 * `topology_solve` transport (PHY-17 RS-2 / TOP-V1, TECHNICAL_SPEC §4 / §13 / §14 / §15): `buildTopologyJob` (@cae) turns the study into a grid,
 * masks, nodal loads, gravity and fixed dofs; `llull-compute topopt` runs the SIMP loop (progress per iteration) and writes `field.bin` /
 * `design.f64` / `displacements.f64` / `state.json` / `result.json`; the field becomes an `fe_topology` artifact in the store and
 * `record_topology_result` recomputes and records its summary. The job gets a wall-clock deadline below the hard timeout: when it is reached the
 * job checkpoints, the transport keeps the state and answers TOP_SOLVER_TIMEOUT with `resumable: true` (`resumeFromLast` continues bit for bit).
 * Without the binary the tool refuses with TOP_TOOL_MISSING (+ NATIVE_TOOL_MISSING install hint): there is no TypeScript fallback.
 * The document is only ever changed by `record_topology_result`.
 */

import type { FeTopologyArtifact, TopologyConstraint, TopologyHistoryRow, TopologyStudy } from '@core/model/topology';
import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@protocol/index';
import { isRecord } from '@lib/isRecord';
import {
  buildTopologyArtifact,
  buildTopologyJob,
  type TopologyJob,
  type TopologySolveOutput,
  topologySummary,
  findStudy,
} from '@cae/index';
import { feaFailure } from '../fea/feaCommon';
import { f64Values, readOutput, withJobFolder, type JobRun } from './computeJob';
import { nativeInstallHint } from './nativeBinary';
import type { NativeDeps } from './fatigueField';
import { loadResume, saveResume, topologyJobFiles, type ResumeState, type TopologyDevice } from './topologyJobFiles';

const TOOL = 'topology_solve';
export const DEFAULT_TOPOLOGY_TIMEOUT_S = 1800;
/** Share of `timeoutS` the job may run before it checkpoints itself, and the least margin kept for the final solve and the outputs. */
const DEADLINE_SHARE = 0.9;
const DEADLINE_MARGIN_S = 5;

/**
 * The job's wall-clock budget for a hard timeout of `seconds`: about 90 % of it, at least `DEADLINE_MARGIN_S` short of it. Below the margin it
 * is 0: the job checkpoints after its first iteration, so even a tiny timeout keeps the margin for the final solve and the outputs.
 */
export const deadlineOf = (seconds: number): number =>
  Math.max(0, Math.min(Math.floor(seconds * DEADLINE_SHARE), seconds - DEADLINE_MARGIN_S));

export interface TopologySolveOptions {
  readonly timeoutS?: number;
  /** Continue the last run of the study (finished or checkpointed: its design, warm start and optimiser state). */
  readonly resumeFromLast?: boolean;
  readonly device?: TopologyDevice;
}

const failure = (code: string, message: string, ids: readonly string[], extra: Record<string, unknown> = {}): FeaToolResult => ({
  ...feaFailure(TOOL, code, message, ids),
  data: { code, ...extra },
});

type Status = 'converged' | 'max_iterations' | 'checkpoint';

interface ParsedResult extends Omit<TopologySolveOutput, 'status'> {
  readonly status: Status;
}

const isConstraint = (value: unknown): value is TopologyConstraint =>
  isRecord(value) &&
  (value['name'] === 'volume' || value['name'] === 'compliance') &&
  typeof value['value'] === 'number' &&
  typeof value['limit'] === 'number' &&
  typeof value['satisfied'] === 'boolean';

/** The `result.json` fields the artifact needs, or an explanation. */
function parseResult(text: string, version: string): ParsedResult | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'result.json is not JSON';
  }
  if (!isRecord(value)) return 'result.json is not an object';
  const { compliance, perLoadCase, iterations, status, history, device, deterministic, optimizer, constraints, projection } = value;
  if (
    typeof compliance !== 'number' ||
    !isRecord(perLoadCase) ||
    typeof iterations !== 'number' ||
    (status !== 'converged' && status !== 'max_iterations' && status !== 'checkpoint') ||
    !Array.isArray(history) ||
    (device !== 'cpu' && device !== 'gpu') ||
    typeof deterministic !== 'boolean'
  )
    return 'result.json lacks compliance, perLoadCase, iterations, status, history, device or deterministic';
  const beta = isRecord(projection) ? projection['beta'] : undefined;
  const eta = isRecord(projection) ? projection['eta'] : undefined;
  return {
    compliance,
    perLoadCase: perLoadCase as Record<string, number>,
    iterations,
    status,
    history: history as TopologyHistoryRow[],
    device,
    deterministic,
    version,
    ...(optimizer === 'oc' || optimizer === 'mma' ? { optimizer } : {}),
    ...(Array.isArray(constraints) && constraints.every(isConstraint) ? { constraints } : {}),
    ...(typeof beta === 'number' && typeof eta === 'number' ? { projection: { beta, eta } } : {}),
  };
}

/** Native failure -> the TOP_* code the agent sees (the job's own code is kept in `data.nativeCode`). */
function topCode(run: JobRun): string {
  if (run.code === 'NATIVE_TIMEOUT') return 'TOP_SOLVER_TIMEOUT';
  if (run.code === 'NATIVE_TOOL_MISSING') return 'TOP_TOOL_MISSING';
  return run.code === 'TOP_GRID_TOO_LARGE' ? 'TOP_GRID_TOO_LARGE' : 'TOP_SOLVER_FAILED';
}

function missingTool(studyId: string): FeaToolResult {
  return failure(
    'TOP_TOOL_MISSING',
    `llull-compute is not installed: topology_solve has no TypeScript fallback. NATIVE_TOOL_MISSING: ${nativeInstallHint('llull-compute')}.`,
    [studyId],
    { nativeCode: 'NATIVE_TOOL_MISSING' },
  );
}

interface Solved {
  readonly artifact: FeTopologyArtifact;
  readonly elapsedMs: number;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly resumedFrom: number;
  readonly state: ResumeState;
}

/** The job stopped at its deadline: a resumable state, no result. */
interface Checkpointed {
  readonly checkpoint: true;
  readonly deadlineS: number;
  readonly elapsedMs: number;
  readonly state: ResumeState;
}

/** One progress line; a resumed run continues the numbering (`done` iterations were run before, the cap is the study's total). */
const progressLine = (event: Readonly<Record<string, unknown>>, done: number): string => {
  const number = (key: string): string => (typeof event[key] === 'number' ? Number(event[key]).toPrecision(6) : '?');
  const count = (key: string): string => (typeof event[key] === 'number' ? String(Number(event[key]) + done) : '?');
  return `${TOOL}: iteration ${count('it')}/${count('total')} compliance ${number('compliance')} volume ${number('volume')} change ${number('change')}`;
};

interface Outputs {
  readonly field: Buffer;
  readonly design: Buffer;
  readonly result: Buffer;
  readonly displacements?: Buffer;
  readonly state?: Buffer;
  readonly mma?: Buffer;
}

/** The resume state a run leaves behind (the native outputs plus the accumulated iteration count and history). */
function resumeStateOf(outputs: Outputs, iterations: number, history: readonly TopologyHistoryRow[]): ResumeState {
  const copy = new Uint8Array(outputs.design.length);
  copy.set(outputs.design);
  const displacements = outputs.displacements === undefined ? undefined : f64Values(outputs.displacements);
  const mma = outputs.mma === undefined ? undefined : f64Values(outputs.mma);
  return {
    design: new Float64Array(copy.buffer),
    ...(displacements === undefined ? {} : { displacements }),
    ...(outputs.state === undefined ? {} : { state: outputs.state.toString('utf8') }),
    ...(mma === undefined ? {} : { mma }),
    iterations,
    history,
  };
}

/** The native run: job folder, `llull-compute topopt`, outputs read back (hash-checked). */
async function solveNatively(
  job: TopologyJob,
  doc: Parameters<typeof topologyJobFiles>[0],
  studyId: string,
  options: TopologySolveOptions,
  deps: NativeDeps,
  resume: ResumeState | null,
): Promise<Solved | Checkpointed | FeaToolResult> {
  const seconds = Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, options.timeoutS ?? DEFAULT_TOPOLOGY_TIMEOUT_S));
  const deadlineS = deadlineOf(seconds);
  const files = topologyJobFiles(
    doc,
    job,
    options.device ?? 'cpu',
    resume === null
      ? undefined
      : {
          design: resume.design,
          ...(resume.displacements === undefined ? {} : { displacements: resume.displacements }),
          ...(resume.state === undefined ? {} : { state: resume.state }),
          ...(resume.mma === undefined ? {} : { mma: resume.mma }),
          iterationsDone: resume.iterations,
        },
    deadlineS,
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
      const optional = async (name: string): Promise<Buffer | undefined> =>
        run.outputs.some((entry) => entry.path === name) ? readOutput(folder, run, name) : undefined;
      const [field, design, result, displacements, state, mma] = await Promise.all([
        readOutput(folder, run, 'field.bin'),
        readOutput(folder, run, 'design.f64'),
        readOutput(folder, run, 'result.json'),
        optional('displacements.f64'),
        optional('state.json'),
        optional('mma.f64'),
      ]);
      const outputs: Outputs = {
        field,
        design,
        result,
        ...(displacements === undefined ? {} : { displacements }),
        ...(state === undefined ? {} : { state }),
        ...(mma === undefined ? {} : { mma }),
      };
      return { run, outputs };
    },
    deps.env,
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in outcome) return failure('TOP_SOLVER_FAILED', `the job folder or its outputs failed: ${outcome.error}`, [studyId]);
  const { run } = outcome;
  const { outputs } = outcome;
  if (outputs === null) {
    const code = topCode(run);
    if (code === 'TOP_TOOL_MISSING') return missingTool(studyId);
    const hint =
      code === 'TOP_SOLVER_TIMEOUT'
        ? ` after ${seconds} s before its ${deadlineS} s checkpoint could be written: the run is lost; use a coarser voxel or a larger timeoutS. resumeFromLast continues a run that finished or checkpointed`
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
  const state = resumeStateOf(outputs, parsed.iterations + before, history);
  if (parsed.status === 'checkpoint') return { checkpoint: true, deadlineS, elapsedMs: run.elapsedMs, state };
  const output: TopologySolveOutput = { ...parsed, status: parsed.status, iterations: parsed.iterations + before, history };
  const artifact = buildTopologyArtifact(job, outputs.field, output, 'topopt');
  if (typeof artifact === 'string') return failure('TOP_SOLVER_FAILED', artifact, [studyId]);
  return { artifact, elapsedMs: run.elapsedMs, warnings: run.warnings, resumedFrom: before, state };
}

/**
 * @failure unknown study -> TOP_STUDY_NOT_FOUND; job refusals -> their TOP_* code; no binary -> TOP_TOOL_MISSING
 *   (+ NATIVE_TOOL_MISSING hint); native errors -> TOP_GRID_TOO_LARGE / TOP_SOLVER_FAILED, timeout or deadline checkpoint -> TOP_SOLVER_TIMEOUT
 *   (data.nativeCode keeps the job's code; a checkpoint sets data.resumable and keeps the state for resumeFromLast); record refusals
 *   (TOP_RESULT_STALE, ...) -> their code from `record_topology_result`
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

  if (deps.runner.binary === null) return missingTool(studyId);
  const resume = options.resumeFromLast === true ? loadResume(deps.store.directory, studyId, job) : null;
  const note =
    options.resumeFromLast === true && resume === null
      ? ' (resumeFromLast: no saved run of this study for these inputs, started from the uniform design)'
      : '';
  const solved = await solveNatively(job, doc, studyId, options, deps, resume);
  if ('checkpoint' in solved) {
    saveResume(deps.store.directory, studyId, job, solved.state);
    return failure(
      'TOP_SOLVER_TIMEOUT',
      `the deadline of ${solved.deadlineS} s was reached after ${solved.state.iterations} iteration(s) (${solved.elapsedMs} ms): the run is checkpointed, re-run topology_solve with resumeFromLast=true to continue it${note}.`,
      [studyId],
      { nativeCode: 'TOP_DEADLINE', resumable: true, iterations: solved.state.iterations, deadlineS: solved.deadlineS },
    );
  }
  if (!('artifact' in solved)) return solved;

  const { artifact } = solved;
  const fieldHash = deps.store.put(artifact);
  saveResume(deps.store.directory, studyId, job, solved.state);
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
      ...(artifact.optimizer === undefined ? {} : { optimizer: artifact.optimizer }),
      ...(artifact.constraints === undefined ? {} : { constraints: artifact.constraints }),
      elapsedMs: solved.elapsedMs,
      ...(solved.resumedFrom > 0 ? { resumedFromIteration: solved.resumedFrom } : {}),
      ...(solved.warnings.length > 0 ? { warnings: solved.warnings } : {}),
      record: recorded.data,
    },
  };
}
