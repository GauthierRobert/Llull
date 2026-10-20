/**
 * fea_solve: current mesh artifact -> `writeInp` (@cae) -> `ccx -i job` in a temp directory -> `parseFrd` / `parseDat` (@cae) ->
 * FeResultsArtifact -> store -> `record_fea_results`. Nonlinear cases also read the `.sta` increment table (convergence) and classify an abnormal stop. The server spawns and forwards; the deck and the parsing are pure @cae functions.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeConvergenceRow, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@protocol/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import type { CcxRunner } from './ccxProcess';
import { currentMesh, feaFailure, INSTALL_HINT, isFailure } from './feaCommon';
import type { RandomPostStep } from '../native/randomField';

export interface FeaSolveDeps {
  readonly store: FeArtifactStore;
  readonly hooks: CaeHooks;
  readonly ccx: CcxRunner;
  /** Keep the job directory (LLULL_FEA_KEEP=1) and report it in `data.jobDirectory`. */
  readonly keepJobs?: boolean;
  /** Largest `.frd` read into memory, in bytes (default MAX_FRD_BYTES). */
  readonly maxResultsBytes?: number;
  /** Host pre-step before the deck (the native temperature mapping, TR-TMC-24); returns a note for the summary or null. Never throws. */
  readonly beforeDeck?: (doc: CadDocument, analysisId: string, mesh: FeMeshArtifact) => Promise<string | null>;
  /** PHY-09 random_response post-step (nodal rms field, native or TypeScript); absent = no nodal field is attached. */
  readonly randomPost?: RandomPostStep;
}

const DEFAULT_SOLVE_TIMEOUT_S = 600;
/** Named guard: largest result file the transport reads (the text is parsed into memory several times over). */
const MAX_FRD_BYTES = 256 * 1024 * 1024;
const JOB = 'job';

/** Totals of the `.sta` rows of a nonlinear solve: increments taken, cutbacks (extra attempts), iterations and the last total time reached. */
function convergenceTotals(rows: readonly FeConvergenceRow[]): {
  readonly increments: number;
  readonly cutbacks: number;
  readonly iterations: number;
  readonly lastTotalTime: number;
} {
  return {
    increments: rows.length,
    cutbacks: rows.reduce((sum, row) => sum + Math.max(0, row.attempts - 1), 0),
    iterations: rows.reduce((sum, row) => sum + row.iterations, 0),
    lastTotalTime: rows.at(-1)?.totalTime ?? 0,
  };
}

function convergenceNote(rows: readonly FeConvergenceRow[]): string {
  const totals = convergenceTotals(rows);
  return `${totals.increments} increment(s), ${totals.cutbacks} cutback(s), ${totals.iterations} iteration(s), total time reached ${totals.lastTotalTime}`;
}

const readOptional = (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '');

/**
 * @failure missing / stale mesh -> FEA_MESH_MISSING / FEA_MESH_STALE; deck refusal -> its code; ccx absent -> FEA_TOOL_MISSING;
 *   `*ERROR`, non-zero exit, timeout or no result step -> FEA_SOLVER_FAILED (log tail in data.log); a nonlinear run that stops on the increment
 *   minimum / INC / divergence -> NLS_INCREMENT_TOO_SMALL / NLS_MAX_INCREMENTS / NLS_NOT_CONVERGED with data.convergence
 */
export async function runFeaSolve(
  analysisId: string,
  timeoutS: number | undefined,
  host: FeaHost,
  deps: FeaSolveDeps,
): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const current = currentMesh('fea_solve', doc, analysisId, deps.store, deps.hooks);
  if (isFailure(current)) return current;
  const nonlinear = doc.analysis?.cases[analysisId]?.type === 'nonlinear_static';
  const random = doc.analysis?.cases[analysisId]?.type === 'random_response';
  const tooLarge = random ? (deps.randomPost?.precheck(doc, analysisId, current.mesh) ?? null) : null;
  if (tooLarge !== null) return feaFailure('fea_solve', tooLarge.code, tooLarge.message, [analysisId]);
  const prepared = deps.beforeDeck === undefined ? null : await deps.beforeDeck(doc, analysisId, current.mesh).catch(() => null);
  const deck = deps.hooks.writeInp(doc, analysisId, current.mesh, deps.store);
  if ('code' in deck) return feaFailure('fea_solve', deck.code, deck.message, [analysisId]);

  const directory = await mkdtemp(path.join(tmpdir(), 'llull-ccx-'));
  try {
    await writeFile(path.join(directory, `${JOB}.inp`), deck.text);
    const seconds = Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, timeoutS ?? DEFAULT_SOLVE_TIMEOUT_S));
    const run = await deps.ccx.run(directory, JOB, seconds * 1000);
    if (run.startError !== undefined) {
      return feaFailure('fea_solve', 'FEA_TOOL_MISSING', `cannot start CalculiX: ${run.startError}. ${INSTALL_HINT.ccx}`, [analysisId]);
    }
    const failed = run.timedOut || run.exitCode !== 0 || /\*ERROR/.test(run.log);
    const convergence = nonlinear ? deps.hooks.parseSta(await readOptional(path.join(directory, `${JOB}.sta`))) : [];
    if (failed) {
      const why = run.timedOut
        ? `timed out after ${seconds} s`
        : run.exitCode !== 0
          ? `exited with code ${String(run.exitCode)}`
          : 'reported *ERROR';
      const stop = nonlinear && !run.timedOut ? deps.hooks.classifyNonlinearStop(run.log) : null;
      const progress = nonlinear ? ` after ${convergenceNote(convergence)}` : '';
      return {
        ...feaFailure('fea_solve', stop ?? 'FEA_SOLVER_FAILED', `CalculiX ${why}${progress}. Last output:\n${run.log.slice(-4000)}`, [
          analysisId,
        ]),
        data: {
          code: stop ?? 'FEA_SOLVER_FAILED',
          log: run.log,
          ...(nonlinear ? { stopCode: stop, convergence: convergenceTotals(convergence) } : {}),
        },
      };
    }
    const frdPath = path.join(directory, `${JOB}.frd`);
    const frdBytes = await stat(frdPath).then(
      (info) => info.size,
      () => 0,
    );
    const cap = deps.maxResultsBytes ?? MAX_FRD_BYTES;
    if (frdBytes > cap) {
      return feaFailure(
        'fea_solve',
        'FEA_RESULTS_TOO_LARGE',
        `the CalculiX result file is ${frdBytes} bytes (cap ${cap}): mesh more coarsely`,
        [analysisId],
      );
    }
    const frdText = await readOptional(frdPath);
    const parsed = deps.hooks.parseFrd(frdText);
    const shellMapped =
      parsed.length === 0 ? { steps: parsed } : deps.hooks.mapShellResults(doc, analysisId, current.mesh, parsed, frdText);
    if ('code' in shellMapped) return feaFailure('fea_solve', shellMapped.code, shellMapped.message, [analysisId]);
    const steps = shellMapped.steps;
    if (steps.length === 0) {
      return feaFailure(
        'fea_solve',
        'FEA_SOLVER_FAILED',
        `CalculiX finished but wrote no result step. Last output:\n${run.log.slice(-4000)}`,
        [analysisId],
      );
    }
    const nonFinite = deps.hooks.firstNonFinite(steps);
    if (nonFinite !== null) {
      return feaFailure('fea_solve', 'FEA_SOLVER_FAILED', `CalculiX wrote non-finite results (${nonFinite}); the solution is not usable`, [
        analysisId,
      ]);
    }
    const datText = await readOptional(path.join(directory, `${JOB}.dat`));
    const dat = datText === '' ? undefined : deps.hooks.parseDat(datText);
    const solved: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: current.meshHash,
      inputHash: deps.hooks.analysisInputHash(doc, analysisId, 'full'),
      solver: 'calculix',
      solverVersion: await deps.ccx.version(),
      steps,
      ...(dat !== undefined ? { dat } : {}),
      ...(nonlinear && convergence.length > 0 ? { convergence } : {}),
    };
    const post = random && deps.randomPost !== undefined ? await deps.randomPost.run(doc, analysisId, current.mesh, solved) : null;
    if (post !== null && !('results' in post)) return feaFailure('fea_solve', post.code, post.message, [analysisId]);
    const results = post?.results ?? solved;
    const resultsHash = deps.store.put(results);
    const stored = deps.store.get(resultsHash);
    if (stored === null || stored.kind !== 'fe_results') {
      return feaFailure(
        'fea_solve',
        'FEA_ARTIFACT_NOT_FOUND',
        `the results artifact ${resultsHash.slice(0, 12)} cannot be read back from the store`,
        [analysisId],
      );
    }
    const recorded = host.applyCommand('record_fea_results', {
      analysisId,
      summary: deps.hooks.resultsSummary(doc, analysisId, current.mesh, stored, resultsHash),
    });
    const increments = nonlinear ? ` ${convergenceNote(convergence)}.` : '';
    return {
      summary: `fea_solve: CalculiX ${results.solverVersion}, ${steps.length} result step(s).${increments}${prepared === null ? '' : ` ${prepared}.`}${post === null ? '' : ` ${post.note}.`} ${recorded.summary}`,
      affected: recorded.affected,
      isError: recorded.isError,
      data: {
        resultsHash,
        steps: steps.length,
        ...(nonlinear ? { convergence: convergenceTotals(convergence) } : {}),
        ...(post !== null ? { nodalField: { engine: post.engine, elapsedMs: post.elapsedMs, deterministic: true } } : {}),
        ...(deps.keepJobs === true ? { jobDirectory: directory } : {}),
      },
    };
  } finally {
    if (deps.keepJobs !== true) await rm(directory, { recursive: true, force: true });
  }
}
