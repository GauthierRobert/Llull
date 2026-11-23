/**
 * `cfd_solve gridStudy` (12 CFD TECHNICAL_SPEC §4 / M3b): the case is solved at three resolutions of refinement ratio 2, the case's own n
 * cells per reference length and n/2 and n/4 (the finest is the case as it stands, so its bundle is the one `record_cfd_results` accepts as
 * current; the coarser ones are the case with only `cellsPerReferenceLength` set, which `record_cfd_grid_study` accepts). All three jobs are
 * built before anything runs (bounds, preparation rows and the memory check refuse by name first), then they run coarsest first. The bundles go
 * to the result store; the document is changed only by `record_cfd_results` (finest) and `record_cfd_grid_study`, dispatched through the host.
 * `cfd_stop` and the caller's signal cancel the whole study between and during runs: nothing is recorded then.
 */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { maxOf, minOf } from '@lib/arrayExtrema';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { cfdCaseOf, type FlowJob } from '@aero/index';
import type { NativeDeps } from '../native/fatigueField';
import { cfdResultPort } from './resultPort';
import {
  activeStudies,
  buildSolveJob,
  failure,
  recordSolve,
  warningsOf,
  runSolveJob,
  TOOL,
  type ActiveStudy,
  type CfdCase,
  type CfdSolveOptions,
  type StoredSolve,
} from './flowSolve';

/** Bounds of `cellsPerReferenceLength` (the case validator's own: `create_cfd_case`). */
const MIN_CELLS = 8;
const MAX_CELLS = 2048;
const LEVELS = 3;

interface Level {
  readonly cells: number;
  readonly cfdCase: CfdCase;
  readonly job: FlowJob;
}

/** Cells per reference length of the three levels, finest first; a string says why the study cannot run at ratio 2. */
function levelCells(own: number, caseId: string): readonly number[] | string {
  const cells = [own, own / 2, own / 4];
  if (!cells.every(Number.isInteger) || minOf(cells) < MIN_CELLS || maxOf(cells) > MAX_CELLS)
    return (
      `a grid study of '${caseId}' runs ${cells.join(' / ')} cells per reference length (the case's own, n/2, n/4: refinement ratio 2); ` +
      `each must be an integer within ${MIN_CELLS}..${MAX_CELLS}: set cellsPerReferenceLength to a multiple of 4 from ${MIN_CELLS * 4} to ${MAX_CELLS} (update_cfd_case)`
    );
  return cells;
}

/** The three jobs (finest first) or the refusal. */
function buildLevels(host: FeaHost, cfdCase: CfdCase, options: CfdSolveOptions, deps: NativeDeps): readonly Level[] | FeaToolResult {
  const caseId = cfdCase.id;
  const doc = host.getDoc();
  const finest = buildSolveJob(doc, cfdCase, options, deps);
  if (!('job' in finest)) return finest;
  const cells = levelCells(finest.job.report.grid.cellsPerReferenceLength, caseId);
  if (typeof cells === 'string') return failure('CFD_PARAM_INVALID', cells, [caseId], { gridStudy: true });
  const levels: Level[] = [{ cells: cells[0] ?? 0, cfdCase, job: finest.job }];
  for (const n of cells.slice(1)) {
    const own = { ...cfdCase, cellsPerReferenceLength: n };
    const built = buildSolveJob(doc, own, options, deps);
    if (!('job' in built)) return built;
    levels.push({ cells: n, cfdCase: own, job: built.job });
  }
  return levels;
}

const cancelled = (caseId: string, why: string): FeaToolResult =>
  failure('CFD_CANCELLED', `the grid study of '${caseId}' was ${why}: nothing was recorded`, [caseId]);

/** Runs the levels coarsest first; the stored solves finest first, or the failure / cancellation that ended the study. */
async function runLevels(
  levels: readonly Level[],
  options: CfdSolveOptions,
  deps: NativeDeps,
  study: ActiveStudy,
): Promise<readonly StoredSolve[] | FeaToolResult> {
  const caseId = study.caseId;
  const stored: StoredSolve[] = [];
  for (const [index, level] of [...levels].reverse().entries()) {
    if (study.stopped) return cancelled(caseId, 'stopped by cfd_stop');
    if (options.signal?.aborted === true) return cancelled(caseId, 'cancelled by its caller');
    const progress = (line: string): void =>
      deps.onProgress?.(`${TOOL} gridStudy ${index + 1}/${LEVELS} (${level.cells} cells/length): ${line}`);
    const result = await runSolveJob(level.job, caseId, options, deps, progress);
    if (!('solved' in result))
      return { ...result, summary: `${TOOL} gridStudy level ${index + 1}/${LEVELS} (${level.cells} cells/length): ${result.summary}` };
    stored.unshift(result);
  }
  return stored;
}

/** The refusal code a host result carries: the command's own (`data.code`, else the first CFD_* code named in its summary). */
const codeOf = (result: FeaToolResult): string => {
  const data = result.data as { code?: unknown } | undefined;
  return typeof data?.code === 'string' ? data.code : (/CFD_[A-Z_]+/.exec(result.summary)?.[0] ?? 'CFD_RECORD_REFUSED');
};

/**
 * @failure unknown case -> CFD_CASE_NOT_FOUND; a level out of 8..2048 or not an integer (the case's n not a multiple of 4) -> CFD_PARAM_INVALID
 *   (data.gridStudy); any level's preparation / memory refusal -> its code, before anything runs; a failed or cancelled level (cfd_stop,
 *   the caller's signal) -> its code and nothing is recorded; the refusal of `record_cfd_grid_study` over the stored bundles (CFD_INPUT_STALE when
 *   the case or the geometry changed while solving, ...) -> that command's own code, found by a dry run BEFORE anything is dispatched, so a
 *   refused study leaves the document untouched; a refusal of `record_cfd_results` -> its code
 */
export async function runCfdGridStudy(caseId: string, options: CfdSolveOptions, host: FeaHost, deps: NativeDeps): Promise<FeaToolResult> {
  const cfdCase = cfdCaseOf(host.getDoc(), caseId);
  if (cfdCase === undefined) return failure('CFD_CASE_NOT_FOUND', `no flow case '${caseId}': create_cfd_case first`, [caseId]);
  const levels = buildLevels(host, cfdCase, options, deps);
  if (!Array.isArray(levels)) return levels as FeaToolResult;
  const study: ActiveStudy = { caseId, stopped: false };
  activeStudies.add(study);
  let stored: readonly StoredSolve[] | FeaToolResult;
  try {
    stored = await runLevels(levels as readonly Level[], options, deps, study);
  } finally {
    activeStudies.delete(study);
  }
  if (!Array.isArray(stored)) return stored as FeaToolResult;
  const solves = stored as readonly StoredSolve[];
  const [finest] = solves;
  if (finest === undefined) return failure('CFD_SOLVER_FAILED', 'the grid study produced no result', [caseId]);
  if (study.stopped) return cancelled(caseId, 'stopped by cfd_stop');

  const resultsHashes = solves.map((entry) => entry.resultsHash);
  const warnings = solves.flatMap((entry, index) =>
    warningsOf(entry.solved).map((warning) => ({ level: levels[index]?.cells, code: warning.code, message: warning.message })),
  );
  const notes = warnings.map((entry) => `level ${entry.level}: ${entry.code}: ${entry.message}`).join('; ');
  const rows = solves.map((entry, index) => ({
    cells: levels[index]?.cells,
    cellM: entry.solved.artifact.grid.cellM,
    resultsHash: entry.resultsHash,
    converged: entry.solved.artifact.converged,
    steps: entry.solved.artifact.steps,
    elapsedMs: entry.solved.elapsedMs,
  }));
  const base = { caseId, resultsHash: finest.resultsHash, resultsHashes, levels: rows, ...(warnings.length > 0 ? { warnings } : {}) };

  // The study command runs first, as a dry run over the document the host holds now and the port its own commands use: a refusal (stale
  // case or geometry, a bundle that does not belong) leaves nothing recorded. Its study is passed back so a replay without the store keeps it.
  const params = {
    caseId,
    resultsHashes,
    ...(options.quantity !== undefined ? { quantity: options.quantity } : {}),
    ...(options.safetyFactor !== undefined ? { safetyFactor: options.safetyFactor } : {}),
  };
  const dry = execute(host.getDoc(), 'record_cfd_grid_study', params, {
    ...defaultContext(),
    cfdResults: deps.cfdResults ?? cfdResultPort(deps.store),
  });
  if (dry.rejected === true)
    return {
      summary: `${TOOL} gridStudy: nothing was recorded: ${dry.summary}`,
      affected: dry.affected,
      isError: true,
      data: { ...base, code: dry.error?.code ?? 'CFD_RECORD_REFUSED' },
    };
  const given = (dry.data as { study?: unknown } | undefined)?.study;

  const { recorded } = recordSolve(host, cfdCase, finest);
  if (recorded.isError)
    return {
      summary: `${TOOL} gridStudy: ${recorded.summary}`,
      affected: recorded.affected,
      isError: true,
      data: { ...base, code: codeOf(recorded), record: recorded.data },
    };
  const studied = host.applyCommand('record_cfd_grid_study', given === undefined ? params : { ...params, study: given });
  return {
    summary:
      `${TOOL} gridStudy: ${levels.map((level) => level.cells).join(' / ')} cells per reference length solved` +
      `${notes === '' ? '' : ` [${notes}]`}. ${recorded.summary} ${studied.summary}`,
    affected: [...new Set([...recorded.affected, ...studied.affected])],
    isError: studied.isError,
    data: { ...base, ...(studied.isError ? { code: codeOf(studied) } : {}), record: recorded.data, gridStudy: studied.data },
  };
}
