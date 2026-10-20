/**
 * `explicit_run` transport (PHY-19 TR-EXP-70, RS1 RS-8a): `buildExplicitJob` (@cae) turns the case into a mesh, materials, initial velocities,
 * rigid walls and controls; `llull-compute explicit` integrates it (progress every few hundred cycles) and writes `result.json` + `fields.f64`;
 * they become an `fe_explicit` artifact in the store and `record_explicit_results` recomputes and records its summary. The document is only
 * ever changed by that record command. Without the binary: EXP_TOOL_MISSING (+ NATIVE_TOOL_MISSING hint); there is no TypeScript fallback.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import { FEA_SOLVE_TIMEOUT_S, type FeaHost, type FeaToolResult } from '@protocol/index';
import { buildExplicitArtifact, buildExplicitJob, explicitSummary } from '@cae/index';
import { feaFailure } from '../fea/feaCommon';
import { f64Values, readOutput, withJobFolder } from './computeJob';
import { nativeInstallHint } from './nativeBinary';
import type { NativeDeps } from './fatigueField';
import { explicitJobFiles, type ExplicitDevice } from './explicitJobFiles';

const TOOL = 'explicit_run';
export const DEFAULT_EXPLICIT_TIMEOUT_S = 3600;

export interface ExplicitRunOptions {
  readonly timeoutS?: number;
  readonly device?: ExplicitDevice;
}

const failure = (code: string, message: string, ids: readonly string[], extra: Record<string, unknown> = {}): FeaToolResult => ({
  ...feaFailure(TOOL, code, message, ids),
  data: { code, ...extra },
});

/** The current 05 mesh artifact of the case (fea_mesh source), or null. */
function meshOf(host: FeaHost, analysisId: string, deps: NativeDeps): FeMeshArtifact | null {
  const hash = host.getDoc().analysis?.cases[analysisId]?.meshSummary?.meshHash;
  const found = hash === undefined ? null : deps.store.get(hash);
  return found?.kind === 'fe_mesh' ? found : null;
}

const progressLine = (event: Readonly<Record<string, unknown>>): string => {
  const number = (key: string): string => (typeof event[key] === 'number' ? Number(event[key]).toPrecision(5) : '?');
  return `${TOOL}: cycle ${String(event['cycle'] ?? '?')} t = ${number('time')} s of ${number('endTime')} s, dt ${number('dt')} s`;
};

/**
 * @failure job refusals -> their EXP_* code; no llull-compute -> EXP_TOOL_MISSING (data.nativeCode NATIVE_TOOL_MISSING); native errors ->
 *   EXP_SOLVER_FAILED, timeout -> EXP_RUN_TIMEOUT (data.nativeCode keeps the job's code); record refusals -> their code
 */
export async function runExplicitRun(
  analysisId: string,
  options: ExplicitRunOptions,
  host: FeaHost,
  deps: NativeDeps,
): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const built = buildExplicitJob(doc, analysisId, meshOf(host, analysisId, deps));
  if (!built.ok) return failure(built.code, built.message, built.ids.length > 0 ? built.ids : [analysisId]);
  const { job } = built;
  if (deps.runner.binary === null)
    return failure('EXP_TOOL_MISSING', `NATIVE_TOOL_MISSING: ${nativeInstallHint('llull-compute')}`, [analysisId], {
      nativeCode: 'NATIVE_TOOL_MISSING',
    });
  const seconds = Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, options.timeoutS ?? DEFAULT_EXPLICIT_TIMEOUT_S));
  const sink = deps.onProgress;
  const outcome = await withJobFolder(
    explicitJobFiles(job, options.device ?? 'cpu'),
    async (folder) => {
      const run = await deps.runner.run(
        ['explicit'],
        folder,
        seconds * 1000,
        sink === undefined ? undefined : (event) => sink(progressLine(event)),
      );
      if (!run.ok) return { run, outputs: null };
      const [result, fields] = await Promise.all([readOutput(folder, run, 'result.json'), readOutput(folder, run, 'fields.f64')]);
      return { run, outputs: { result, fields } };
    },
    deps.env,
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in outcome) return failure('EXP_SOLVER_FAILED', `the job folder or its outputs failed: ${outcome.error}`, [analysisId]);
  const { run, outputs } = outcome;
  if (outputs === null) {
    const code =
      run.code === 'NATIVE_TIMEOUT' ? 'EXP_RUN_TIMEOUT' : run.code === 'NATIVE_TOOL_MISSING' ? 'EXP_TOOL_MISSING' : 'EXP_SOLVER_FAILED';
    return failure(code, `${run.message ?? 'llull-compute failed'}. Last output:\n${run.log.slice(-2000)}`, [analysisId], {
      nativeCode: run.code,
      log: run.log.slice(-4000),
    });
  }
  const artifact = buildExplicitArtifact(job, outputs.result.toString('utf8'), f64Values(outputs.fields), await deps.runner.version());
  if (typeof artifact === 'string') return failure('EXP_SOLVER_FAILED', artifact, [analysisId]);
  const artifactHash = deps.store.put(artifact);
  const analysisCase = doc.analysis?.cases[analysisId];
  const summary = analysisCase === undefined ? 'the case disappeared' : explicitSummary(doc, analysisCase, artifact, artifactHash);
  if (typeof summary === 'string') return failure('EXP_SUMMARY_MISMATCH', summary, [analysisId, artifactHash]);
  const recorded = host.applyCommand('record_explicit_results', { analysisId, artifactHash, summary });
  const warnings = run.warnings.map((warning) => `${warning.code}: ${warning.message}`).join('; ');
  return {
    summary: `${TOOL}: llull-explicit ${artifact.solver.version} (${artifact.solver.device}${artifact.solver.deterministic ? ', deterministic' : ''}) ${artifact.cycles} cycles in ${run.elapsedMs} ms${warnings === '' ? '' : ` [${warnings}]`}. ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      analysisId,
      artifactHash,
      inputHash: artifact.inputHash,
      solver: artifact.solver,
      termination: artifact.termination,
      cycles: artifact.cycles,
      elapsedMs: run.elapsedMs,
      ...(run.warnings.length > 0 ? { warnings: run.warnings } : {}),
      summary,
      record: recorded.data,
    },
  };
}
