/** record_fe_mesh / record_fea_results: store the summary of a host-produced artifact, validated against the artifact store (05 §4.1). */

import type { AnalysisCase, FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '../hash/inputHash';
import { stressUnitName } from '../decks/units';
import { meshSummary, resultsSummary } from '../results/summary';
import { caseOf, withCase } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';

const summaryNote =
  'Exactly the summary returned by the host transport (never hand-written): it is recomputed from the artifact and compared.';

/** Top-level keys whose values differ between two summaries. */
const differingKeys = (given: object, expected: object): string[] => {
  const left = new Map(Object.entries(given));
  const right = new Map(Object.entries(expected));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => canonicalJson(left.get(key)) !== canonicalJson(right.get(key)))
    .sort();
};

type Fetched<T> = { readonly artifact: T } | { readonly code: string; readonly message: string };

function fetchArtifact<K extends 'fe_mesh' | 'fe_results'>(
  port: FeArtifactPort | null | undefined,
  hash: string,
  kind: K,
): Fetched<Extract<FeMeshArtifact | FeResultsArtifact, { kind: K }>> {
  const found = port?.get(hash) ?? null;
  if (found === null || found.kind !== kind)
    return {
      code: 'FEA_ARTIFACT_NOT_FOUND',
      message: port ? `no ${kind} artifact for hash ${hash}` : `no artifact store available for ${kind} ${hash}`,
    };
  if (sha256Hex(canonicalJson(found)) !== hash)
    return { code: 'FEA_SUMMARY_MISMATCH', message: `the sha256 of the ${kind} artifact is not ${hash}` };
  return { artifact: found as Extract<FeMeshArtifact | FeResultsArtifact, { kind: K }> };
}

function withoutResults(analysisCase: AnalysisCase): AnalysisCase {
  const { results, ...rest } = analysisCase;
  return results === undefined ? analysisCase : rest;
}

/**
 * @affects doc.analysis.cases[analysisId].meshSummary (set); recorded results are cleared
 * @invariant the artifact for summary.meshHash is in ctx.feaArtifacts, its sha256 equals the hash, its inputHash is the current mesh input
 *   hash, and summary equals the summary recomputed from it (trust model, 05 §4.1)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; no port / no artifact -> FEA_ARTIFACT_NOT_FOUND; sha256 or summary differs ->
 *   FEA_SUMMARY_MISMATCH; artifact built for other inputs -> FEA_INPUT_STALE (all refusals, unchanged doc)
 */
export const recordFeMesh = defineCommand({
  name: 'record_fe_mesh',
  description:
    'Record the summary of a finite-element mesh built by the host (fea_mesh transport) on an analysis. Not for hand use: the summary is ' +
    're-derived from the stored mesh artifact and refused unless it matches exactly, so numbers cannot be invented. Clears recorded results. ' +
    'Refused with FEA_ARTIFACT_NOT_FOUND when the artifact store does not hold the mesh, FEA_SUMMARY_MISMATCH when the summary differs, ' +
    'FEA_INPUT_STALE when the analysis changed since the mesh was built.',
  params: z.object({
    analysisId: analysisIdSchema,
    summary: z.looseObject({ meshHash: z.string().describe('sha256 of the canonical mesh artifact JSON.') }).describe(summaryNote),
  }),
  run: (doc: CadDocument, { analysisId, summary }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId]): CommandResult =>
      refuseFe(doc, 'record_fe_mesh', code, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
    const fetched = fetchArtifact(ctx?.feaArtifacts, summary.meshHash, 'fe_mesh');
    if ('code' in fetched) return fail(fetched.code, fetched.message, [analysisId, summary.meshHash]);
    const expected = meshSummary(fetched.artifact, summary.meshHash);
    const differing = differingKeys(summary, expected);
    if (differing.length > 0)
      return fail('FEA_SUMMARY_MISMATCH', `the summary differs from the one recomputed from the artifact in: ${differing.join(', ')}`, [
        analysisId,
        summary.meshHash,
      ]);
    if (fetched.artifact.inputHash !== analysisInputHash(doc, analysisId, 'mesh'))
      return fail('FEA_INPUT_STALE', `the mesh was built for other inputs than the current analysis '${analysisId}'`);
    return changed(
      withCase(doc, { ...withoutResults(analysisCase), meshSummary: expected }),
      `record_fe_mesh: '${analysisId}' meshed — ${expected.nodes} nodes, ${Object.entries(expected.elements)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ')}, ${expected.quality.inverted} inverted (${expected.mesher} ${expected.mesherVersion}).`,
      [analysisId],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].results (set)
 * @invariant as record_fe_mesh for summary.resultsHash; additionally the case has a recorded mesh, the results were computed on exactly that
 *   mesh (results.meshHash) and for the current full input hash; summarised against the recorded mesh artifact
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; no port / no results or mesh artifact -> FEA_ARTIFACT_NOT_FOUND; sha256 or summary
 *   differs -> FEA_SUMMARY_MISMATCH; no recorded mesh or other meshHash -> FEA_MESH_MISMATCH; other inputs -> FEA_INPUT_STALE
 */
export const recordFeaResults = defineCommand({
  name: 'record_fea_results',
  description:
    'Record the summary of solver results produced by the host (fea_solve transport) on an analysis that has a recorded mesh. Not for hand ' +
    'use: the summary is re-derived from the stored results artifact and refused unless it matches exactly. Refused with ' +
    'FEA_ARTIFACT_NOT_FOUND (artifact absent), FEA_SUMMARY_MISMATCH, FEA_MESH_MISMATCH (results not computed on the recorded mesh, or no ' +
    'mesh recorded) or FEA_INPUT_STALE (analysis changed since the solve).',
  params: z.object({
    analysisId: analysisIdSchema,
    summary: z.looseObject({ resultsHash: z.string().describe('sha256 of the canonical results artifact JSON.') }).describe(summaryNote),
  }),
  run: (doc: CadDocument, { analysisId, summary }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId]): CommandResult =>
      refuseFe(doc, 'record_fea_results', code, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
    const recordedMesh = analysisCase.meshSummary;
    if (recordedMesh === undefined)
      return fail('FEA_MESH_MISMATCH', `analysis '${analysisId}' has no recorded mesh (record_fe_mesh first)`);
    const fetched = fetchArtifact(ctx?.feaArtifacts, summary.resultsHash, 'fe_results');
    if ('code' in fetched) return fail(fetched.code, fetched.message, [analysisId, summary.resultsHash]);
    const results = fetched.artifact;
    if (results.meshHash !== recordedMesh.meshHash)
      return fail(
        'FEA_MESH_MISMATCH',
        `the results were computed on mesh ${results.meshHash}, the recorded mesh is ${recordedMesh.meshHash}`,
        [analysisId, results.meshHash],
      );
    const mesh = fetchArtifact(ctx?.feaArtifacts, recordedMesh.meshHash, 'fe_mesh');
    if ('code' in mesh) return fail(mesh.code, mesh.message, [analysisId, recordedMesh.meshHash]);
    const expected = resultsSummary(doc, analysisId, mesh.artifact, results, summary.resultsHash);
    const differing = differingKeys(summary, expected);
    if (differing.length > 0)
      return fail('FEA_SUMMARY_MISMATCH', `the summary differs from the one recomputed from the artifact in: ${differing.join(', ')}`, [
        analysisId,
        summary.resultsHash,
      ]);
    if (results.inputHash !== analysisInputHash(doc, analysisId, 'full'))
      return fail('FEA_INPUT_STALE', `the results were computed for other inputs than the current analysis '${analysisId}'`);
    return changed(
      withCase(doc, { ...analysisCase, results: expected }),
      `record_fea_results: '${analysisId}' solved — ${expected.loadCases.length} load case(s)${expected.loadCases
        .map(
          (lc) =>
            `; ${lc.name}: max von Mises ${significantNumber(lc.maxVonMises.value, 6)} ${stressUnitName(expected.units)}, max displacement ${significantNumber(lc.maxDisplacement.value, 6)}`,
        )
        .join(
          '',
        )}${expected.thermal === undefined ? '' : `; thermal: ${expected.thermal.times.length} time(s)`} (${expected.solver} ${expected.solverVersion}).`,
      [analysisId],
    );
  },
});
