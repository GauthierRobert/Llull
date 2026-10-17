/**
 * fea_solve: current mesh artifact -> `writeInp` (@cae) -> `ccx -i job` in a temp directory -> `parseFrd` / `parseDat` (@cae) ->
 * FeResultsArtifact -> store -> `record_fea_results`. The server spawns and forwards; the deck and the parsing are pure @cae functions.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeResultsArtifact } from '@core/model/analysis';
import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@mcp/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import type { CcxRunner } from './ccxProcess';
import { currentMesh, feaFailure, INSTALL_HINT, isFailure } from './feaCommon';

export interface FeaSolveDeps {
  readonly store: FeArtifactStore;
  readonly hooks: CaeHooks;
  readonly ccx: CcxRunner;
  /** Keep the job directory (LLULL_FEA_KEEP=1) and report it in `data.jobDirectory`. */
  readonly keepJobs?: boolean;
  /** Largest `.frd` read into memory, in bytes (default MAX_FRD_BYTES). */
  readonly maxResultsBytes?: number;
}

const DEFAULT_SOLVE_TIMEOUT_S = 600;
/** Named guard: largest result file the transport reads (the text is parsed into memory several times over). */
const MAX_FRD_BYTES = 256 * 1024 * 1024;
const JOB = 'job';

const readOptional = (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '');

/**
 * @failure missing / stale mesh -> FEA_MESH_MISSING / FEA_MESH_STALE; deck refusal -> its code; ccx absent -> FEA_TOOL_MISSING;
 *   `*ERROR`, non-zero exit, timeout or no result step -> FEA_SOLVER_FAILED (log tail in data.log)
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
    if (failed) {
      const why = run.timedOut
        ? `timed out after ${seconds} s`
        : run.exitCode !== 0
          ? `exited with code ${String(run.exitCode)}`
          : 'reported *ERROR';
      return {
        ...feaFailure('fea_solve', 'FEA_SOLVER_FAILED', `CalculiX ${why}. Last output:\n${run.log.slice(-4000)}`, [analysisId]),
        data: { code: 'FEA_SOLVER_FAILED', log: run.log },
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
    const steps = deps.hooks.parseFrd(await readOptional(frdPath));
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
    const results: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: current.meshHash,
      inputHash: deps.hooks.analysisInputHash(doc, analysisId, 'full'),
      solver: 'calculix',
      solverVersion: await deps.ccx.version(),
      steps,
      ...(dat !== undefined ? { dat } : {}),
    };
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
    return {
      summary: `fea_solve: CalculiX ${results.solverVersion}, ${steps.length} result step(s). ${recorded.summary}`,
      affected: recorded.affected,
      isError: recorded.isError,
      data: { resultsHash, steps: steps.length, ...(deps.keepJobs === true ? { jobDirectory: directory } : {}) },
    };
  } finally {
    if (deps.keepJobs !== true) await rm(directory, { recursive: true, force: true });
  }
}
