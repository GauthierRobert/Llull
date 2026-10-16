/**
 * fea_solve: current mesh artifact -> `writeInp` (@cae) -> `ccx -i job` in a temp directory -> `parseFrd` / `parseDat` (@cae) ->
 * FeResultsArtifact -> store -> `record_fea_results`. The server spawns and forwards; the deck and the parsing are pure @cae functions.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeResultsArtifact } from '@core/model/analysis';
import type { FeaHost, FeaToolResult } from '@mcp/index';
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
}

const DEFAULT_SOLVE_TIMEOUT_S = 600;
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
  const deck = deps.hooks.writeInp(doc, analysisId, current.mesh);
  if ('code' in deck) return feaFailure('fea_solve', deck.code, deck.message, [analysisId]);

  const directory = await mkdtemp(path.join(tmpdir(), 'llull-ccx-'));
  try {
    await writeFile(path.join(directory, `${JOB}.inp`), deck.text);
    const seconds = timeoutS ?? DEFAULT_SOLVE_TIMEOUT_S;
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
    const steps = deps.hooks.parseFrd(await readOptional(path.join(directory, `${JOB}.frd`)));
    if (steps.length === 0) {
      return feaFailure(
        'fea_solve',
        'FEA_SOLVER_FAILED',
        `CalculiX finished but wrote no result step. Last output:\n${run.log.slice(-4000)}`,
        [analysisId],
      );
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
    const recorded = host.applyCommand('record_fea_results', {
      analysisId,
      summary: deps.hooks.resultsSummary(doc, analysisId, current.mesh, results, resultsHash),
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
