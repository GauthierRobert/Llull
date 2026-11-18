/**
 * fea_solve: current mesh artifact -> `writeInp` (@cae) -> `ccx -i job` in a temp directory -> `parseFrd` / `parseDat` (@cae) ->
 * FeResultsArtifact -> store -> `record_fea_results`. Nonlinear cases also read the `.sta` increment table (convergence) and classify an abnormal stop. The server spawns and forwards; the deck and the parsing are pure @cae functions.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeConvergenceRow, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import type { CadDocument } from '@core/model/types';
import { FEA_SOLVE_THREADS, FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaSolveOptions, type FeaToolResult } from '@protocol/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import type { CcxRunner } from './ccxProcess';
import { errorMessage } from '@lib/errorMessage';
import { currentMesh, feaFailure, INSTALL_HINT, isFailure } from './feaCommon';
import type { RandomPostStep } from '../native/randomField';
import type { ProcessResult } from '../processRunner';

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

/** A native pre-step that threw: the TypeScript mapper still maps, so the results stay right; the failure is reported in the summary (FR-INT-13). */
/** The native mapping pre-step failed; the TypeScript mapper takes over (machine-readable twin of the summary note). */
interface MappingFallback {
  readonly step: 'native-mapping';
  readonly reason: string;
}

const nativeMappingFailure = (error: unknown): { readonly note: string; readonly fallback: MappingFallback } => ({
  note: `native mapping failed (${errorMessage(error)}); mapped in TypeScript`,
  fallback: { step: 'native-mapping', reason: errorMessage(error) },
});

/** Summary sentence of the mesh adequacy verdict (FR-INT-06); names the parts and the budget when it is not adequate. */
function adequacyNote(adequacy: FeMeshAdequacy, hooks: CaeHooks): string {
  if (adequacy.verdict === 'adequate') return `Mesh adequacy: adequate (${adequacy.parts.length} part measurement(s)).`;
  return `Mesh adequacy: ${adequacy.verdict.toUpperCase()} - ${hooks.inadequacyReasons(adequacy).join('; ')}${adequacy.verdict === 'inadequate' ? '; compute_margins reports not_assessed rows until the mesh is refined' : ''}.`;
}

const readOptional = (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '');

interface SolveInput {
  readonly analysisId: string;
  readonly host: FeaHost;
  readonly deps: FeaSolveDeps;
  readonly doc: CadDocument;
  readonly current: { readonly mesh: FeMeshArtifact; readonly meshHash: string };
  readonly nonlinear: boolean;
  readonly random: boolean;
  /** Solver threads of this run (1 = bit-reproducible). */
  readonly threads: number;
  /** The static steps run on the iterative solver. */
  readonly iterative: boolean;
}

interface PreparedDeck {
  readonly deckText: string;
  readonly prepared: string | null;
  readonly fallback: MappingFallback | null;
}

type ResultSteps = FeResultsArtifact['steps'];

async function prepareDeck(input: SolveInput): Promise<FeaToolResult | PreparedDeck> {
  const { analysisId, deps, doc, current, random } = input;
  const tooLarge = random ? (deps.randomPost?.precheck(doc, analysisId, current.mesh) ?? null) : null;
  if (tooLarge !== null) return feaFailure('fea_solve', tooLarge.code, tooLarge.message, [analysisId]);
  const mapping =
    deps.beforeDeck === undefined
      ? null
      : await deps.beforeDeck(doc, analysisId, current.mesh).then(
          (note) => ({ note, fallback: null }),
          (error: unknown) => nativeMappingFailure(error),
        );
  const prepared = mapping?.note ?? null;
  const fallback = mapping?.fallback ?? null;
  const deck = deps.hooks.writeInp(doc, analysisId, current.mesh, deps.store);
  if ('code' in deck) {
    return {
      ...feaFailure(
        'fea_solve',
        deck.code,
        fallback === null ? deck.message : `${deck.message} (the native mapping step had failed first: ${fallback.reason})`,
        [analysisId],
      ),
      data: { code: deck.code, ...(fallback === null ? {} : { mappingFallback: fallback }) },
    };
  }
  if (!input.iterative) return { deckText: deck.text, prepared, fallback };
  const iterative = deps.hooks.iterativeSolverDeck(doc, analysisId, deck.text);
  if ('code' in iterative) return feaFailure('fea_solve', iterative.code, iterative.message, [analysisId]);
  return { deckText: iterative.text, prepared, fallback };
}

function solverFailure(input: SolveInput, run: ProcessResult, seconds: number, convergence: readonly FeConvergenceRow[]): FeaToolResult {
  const { analysisId, deps, nonlinear } = input;
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

async function runCcx(
  input: SolveInput,
  directory: string,
  timeoutS: number | undefined,
): Promise<FeaToolResult | { readonly run: ProcessResult; readonly convergence: FeConvergenceRow[] }> {
  const { analysisId, deps, nonlinear } = input;
  const seconds = Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, timeoutS ?? DEFAULT_SOLVE_TIMEOUT_S));
  const run = await deps.ccx.run(directory, JOB, seconds * 1000, input.threads);
  if (run.startError !== undefined) {
    return feaFailure('fea_solve', 'FEA_TOOL_MISSING', `cannot start CalculiX: ${run.startError}. ${INSTALL_HINT.ccx}`, [analysisId]);
  }
  const failed = run.timedOut || run.exitCode !== 0 || /\*ERROR/.test(run.log);
  const convergence = nonlinear ? deps.hooks.parseSta(await readOptional(path.join(directory, `${JOB}.sta`))) : [];
  if (failed) return solverFailure(input, run, seconds, convergence);
  return { run, convergence };
}

async function readResultSteps(
  input: SolveInput,
  directory: string,
  run: ProcessResult,
): Promise<FeaToolResult | { readonly steps: ResultSteps }> {
  const { analysisId, deps, doc, current } = input;
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
  const shellMapped = parsed.length === 0 ? { steps: parsed } : deps.hooks.mapShellResults(doc, analysisId, current.mesh, parsed, frdText);
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
  return { steps };
}

async function recordSolved(
  input: SolveInput,
  directory: string,
  deck: PreparedDeck,
  adequacy: FeMeshAdequacy,
  convergence: FeConvergenceRow[],
  steps: ResultSteps,
): Promise<FeaToolResult> {
  const { analysisId, host, deps, doc, current, nonlinear, random } = input;
  const { prepared, fallback } = deck;
  const datText = await readOptional(path.join(directory, `${JOB}.dat`));
  const dat = datText === '' ? undefined : deps.hooks.parseDat(datText);
  const solved: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: current.meshHash,
    inputHash: deps.hooks.analysisInputHash(doc, analysisId, 'full'),
    solver: 'calculix',
    solverVersion: await deps.ccx.version(),
    ...(input.iterative ? { solverMethod: 'iterative' as const } : {}),
    ...(input.threads > 1 ? { solverThreads: input.threads } : {}),
    steps,
    ...(dat !== undefined ? { dat } : {}),
    ...(nonlinear && convergence.length > 0 ? { convergence } : {}),
    adequacy,
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
  const method = input.iterative ? ' Iterative solver: results agree with a direct solve to about three digits (a few 1e-4 relative).' : '';
  const threaded =
    input.threads > 1 ? ` ${input.threads} solver threads: the last digits vary between runs (threads 1 is bit-reproducible).` : '';
  return {
    summary: `fea_solve: CalculiX ${results.solverVersion}, ${steps.length} result step(s).${increments}${method}${threaded}${prepared === null ? '' : ` ${prepared}.`} ${adequacyNote(adequacy, deps.hooks)}${post === null ? '' : ` ${post.note}.`} ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      resultsHash,
      steps: steps.length,
      threads: input.threads,
      solver: input.iterative ? 'iterative' : 'direct',
      ...(fallback === null ? {} : { mappingFallback: fallback }),
      ...(nonlinear ? { convergence: convergenceTotals(convergence) } : {}),
      ...(post !== null ? { nodalField: { engine: post.engine, elapsedMs: post.elapsedMs, deterministic: true } } : {}),
      ...(deps.keepJobs === true ? { jobDirectory: directory } : {}),
    },
  };
}

/**
 * @failure missing / stale mesh -> FEA_MESH_MISSING / FEA_MESH_STALE; deck refusal -> its code; ccx absent -> FEA_TOOL_MISSING;
 *   `*ERROR`, non-zero exit, timeout or no result step -> FEA_SOLVER_FAILED (log tail in data.log); a nonlinear run that stops on the increment
 *   minimum / INC / divergence -> NLS_INCREMENT_TOO_SMALL / NLS_MAX_INCREMENTS / NLS_NOT_CONVERGED with data.convergence
 */
export async function runFeaSolve(analysisId: string, options: FeaSolveOptions, host: FeaHost, deps: FeaSolveDeps): Promise<FeaToolResult> {
  const { timeoutS } = options;
  const wanted = Math.floor(options.threads ?? deps.ccx.defaultThreads ?? 1);
  const threads = Math.min(FEA_SOLVE_THREADS.max, Math.max(FEA_SOLVE_THREADS.min, wanted));
  const doc = host.getDoc();
  const current = currentMesh('fea_solve', doc, analysisId, deps.store, deps.hooks);
  if (isFailure(current)) return current;
  const nonlinear = doc.analysis?.cases[analysisId]?.type === 'nonlinear_static';
  const random = doc.analysis?.cases[analysisId]?.type === 'random_response';
  const input: SolveInput = { analysisId, host, deps, doc, current, nonlinear, random, threads, iterative: options.solver === 'iterative' };
  const deck = await prepareDeck(input);
  if (isFailure(deck)) return deck;

  const adequacy = deps.hooks.meshAdequacy(current.mesh);
  const directory = await mkdtemp(path.join(tmpdir(), 'llull-ccx-'));
  try {
    await writeFile(path.join(directory, `${JOB}.inp`), deck.deckText);
    const solved = await runCcx(input, directory, timeoutS);
    if (isFailure(solved)) return solved;
    const read = await readResultSteps(input, directory, solved.run);
    if (isFailure(read)) return read;
    return await recordSolved(input, directory, deck, adequacy, solved.convergence, read.steps);
  } finally {
    if (deps.keepJobs !== true) await rm(directory, { recursive: true, force: true });
  }
}
