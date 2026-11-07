/**
 * run_convergence_study: one analysis re-meshed and re-solved at 3 to 6 mesh sizes (coarsest first: fail fast, cheap) through the SAME fea_mesh /
 * fea_solve transports, each level in an in-memory copy of the document (the case's own mesh controls are never touched), then
 * `record_convergence_study` on the real document. The server loops and forwards; the plan, the spacing and the values are pure @cae functions
 * (`planStudy`, `studyParams`), the GCI arithmetic is `@lib/convergence`.
 */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import type { ConvergenceStudyOptions, FeaHost, FeaToolResult } from '@protocol/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import { feaFailure } from './feaCommon';

const TOOL = 'run_convergence_study';

export interface FeaConvergenceDeps {
  readonly store: FeArtifactStore;
  readonly hooks: CaeHooks;
  /** The fea_mesh transport (the real one in the port; a fake in the tests). */
  readonly mesh: (analysisId: string, host: FeaHost) => Promise<FeaToolResult>;
  /** The fea_solve transport. */
  readonly solve: (analysisId: string, options: { readonly timeoutS?: number }, host: FeaHost) => Promise<FeaToolResult>;
}

/** A host over a private copy of the document: commands run through `execute` against the store, nothing reaches the real document. */
function levelHost(initial: CadDocument, store: FeArtifactStore): FeaHost {
  let current = initial;
  return {
    getDoc: () => current,
    applyCommand: (name, params): FeaToolResult => {
      const result = execute(current, name, params, { ...defaultContext(), feaArtifacts: store });
      if (result.rejected !== true) current = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
    },
  };
}

const causeOf = (result: FeaToolResult): string =>
  isRecord(result.data) && typeof result.data['code'] === 'string' ? result.data['code'] : 'unknown';

const levelFailure = (analysisId: string, index: number, stage: string, result: FeaToolResult): FeaToolResult => ({
  ...feaFailure(TOOL, 'VNV_LEVEL_FAILED', `level ${index} ${stage} failed with ${causeOf(result)}: ${result.summary}`, [analysisId]),
  data: { code: 'VNV_LEVEL_FAILED', level: index, stage, cause: causeOf(result) },
});

/**
 * @failure bad options -> VNV_PARAM_INVALID / VNV_RATIO_TOO_SMALL / VNV_CASE_UNSUPPORTED / FEA_ANALYSIS_NOT_FOUND; a level that does not mesh or
 *   solve -> VNV_LEVEL_FAILED with the 05 code in data.cause (the document is unchanged; finished levels stay in the artifact cache); a level mesh
 *   above the element cap -> VNV_LEVEL_TOO_LARGE (before its solve); the record command's refusal otherwise
 */
export async function runConvergenceStudy(
  analysisId: string,
  options: ConvergenceStudyOptions,
  host: FeaHost,
  deps: FeaConvergenceDeps,
): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const plan = deps.hooks.planStudy(doc, analysisId, options);
  if (deps.hooks.isStudyRefusal(plan)) return feaFailure(TOOL, plan.code, plan.message, [analysisId]);
  const solveOptions = options.timeoutS === undefined ? {} : { timeoutS: options.timeoutS };
  const runs = new Map<number, { mesh: FeMeshArtifact; meshHash: string; results: FeResultsArtifact; resultsHash: string }>();
  for (const level of [...plan.levels].reverse()) {
    const sandbox = levelHost(deps.hooks.levelDocumentOf(doc, analysisId, level.controls), deps.store);
    const meshed = await deps.mesh(analysisId, sandbox);
    if (meshed.isError) return levelFailure(analysisId, level.index, 'meshing', meshed);
    const meshSummary = sandbox.getDoc().analysis?.cases[analysisId]?.meshSummary;
    const elements = Object.values(meshSummary?.elements ?? {}).reduce((sum, count) => sum + count, 0);
    if (elements > deps.hooks.maxStudyElements)
      return feaFailure(
        TOOL,
        'VNV_LEVEL_TOO_LARGE',
        `level ${level.index} has ${elements} elements (cap ${deps.hooks.maxStudyElements}): use fewer levels or a coarser finest size`,
        [analysisId],
      );
    const solved = await deps.solve(analysisId, solveOptions, sandbox);
    if (solved.isError) return levelFailure(analysisId, level.index, 'solving', solved);
    const recorded = sandbox.getDoc().analysis?.cases[analysisId];
    const meshHash = recorded?.meshSummary?.meshHash;
    const resultsHash = recorded?.results?.resultsHash;
    const mesh = meshHash === undefined ? null : deps.store.get(meshHash);
    const results = resultsHash === undefined ? null : deps.store.get(resultsHash);
    if (meshHash === undefined || resultsHash === undefined || mesh?.kind !== 'fe_mesh' || results?.kind !== 'fe_results')
      return feaFailure(TOOL, 'VNV_LEVEL_FAILED', `level ${level.index}: the mesh or results artifact cannot be read back from the store`, [
        analysisId,
      ]);
    runs.set(level.index, { mesh, meshHash, results, resultsHash });
  }
  const ordered = plan.levels.flatMap((level) => {
    const run = runs.get(level.index);
    return run === undefined ? [] : [{ index: level.index, controls: level.controls, ...run }];
  });
  const study = deps.hooks.studyParams(doc, analysisId, plan, ordered, options);
  if (deps.hooks.isStudyRefusal(study)) return feaFailure(TOOL, study.code, study.message, [analysisId]);
  const recorded = host.applyCommand('record_convergence_study', { analysisId, study });
  return {
    summary: `${TOOL}: ${ordered.length} levels, globalSize ${ordered.map((run) => run.controls.globalSize.toPrecision(4)).join(' / ')}. ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      levels: ordered.map((run) => ({
        index: run.index,
        globalSize: run.controls.globalSize,
        meshHash: run.meshHash,
        resultsHash: run.resultsHash,
      })),
      ratio: plan.ratio,
      next: 'check_verification',
    },
  };
}
