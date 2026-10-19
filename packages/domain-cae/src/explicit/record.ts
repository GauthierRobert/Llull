/** record_explicit_results: store the summary of a host-produced explicit run, validated against the artifact store (05 §4.1, TR-EXP-51). */

import type { ExplicitResultsSummary } from '@core/model/explicit';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { differingKeys } from '../shared/trust';
import { analysisIdSchema } from '../shared/schemas';
import { explicitSummary } from './artifact';
import { refuseExplicit } from './codes';
import { explicitInputHash } from './hash';
import { explicitCase, withSpec } from './model';
import { fetchExplicitArtifact } from './trust';

/**
 * @affects doc.analysis.cases[analysisId].explicit.results (set)
 * @invariant the artifact exists in the store and hashes to artifactHash, was built for the current inputs, and the stored summary is the one
 *   recomputed from it (an agent cannot supply numbers); a given summary must equal the recomputed one; WITHOUT the artifact (replay on another
 *   machine) a given summary is kept flagged `verified: false` - state `missing`, never read as numbers
 * @failure unknown / non-explicit case / no controls -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE / EXP_CONTROLS_MISSING; artifact absent and no
 *   summary -> EXP_ARTIFACT_NOT_FOUND; hash or summary differ -> EXP_SUMMARY_MISMATCH; artifact of other inputs -> EXP_RESULT_STALE
 */
export const recordExplicitResults = defineCommand({
  name: 'record_explicit_results',
  description:
    'Record the result of an explicit dynamics run made by the host (explicit_run transport) on an explicit_dynamics case. Not for hand use: the ' +
    'summary is re-derived from the stored fe_explicit artifact, so numbers cannot be invented. `summary` is optional; when given it must equal the ' +
    'recomputed one (the transport passes it so a replay without the artifact store keeps the record as unverified, state missing). Refused with ' +
    'EXP_ARTIFACT_NOT_FOUND, EXP_SUMMARY_MISMATCH or EXP_RESULT_STALE (the set-up changed since the run: re-run explicit_run).',
  params: z.object({
    analysisId: analysisIdSchema,
    artifactHash: z.string().describe('sha256 of the canonical fe_explicit artifact JSON, as returned by explicit_run.'),
    summary: z
      .looseObject({ artifactHash: z.string().describe('Same as artifactHash.') })
      .optional()
      .describe('Exactly the summary returned by the transport (never hand-written): it is recomputed from the artifact and compared.'),
  }),
  run: (doc, { analysisId, artifactHash, summary }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId, artifactHash]): CommandResult =>
      refuseExplicit(doc, 'record_explicit_results', code, message, ids);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message, [analysisId]);
    const { analysisCase, spec } = found;
    if (spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls`, [analysisId]);
    const fetched = fetchExplicitArtifact(ctx?.feaArtifacts, artifactHash);
    if ('code' in fetched) {
      if (fetched.code === 'EXP_SUMMARY_MISMATCH') return fail(fetched.code, fetched.message);
      if (summary === undefined || summary.artifactHash !== artifactHash || typeof summary['inputHash'] !== 'string')
        return fail('EXP_ARTIFACT_NOT_FOUND', fetched.message);
      const flagged = { ...summary, verified: false } as unknown as ExplicitResultsSummary;
      return changed(
        withSpec(doc, analysisCase, { ...spec, results: flagged }),
        `record_explicit_results: ${analysisId} result ${artifactHash.slice(0, 12)} recorded UNVERIFIED (artifact not available on this machine): state missing, no number is used until explicit_run is run here.`,
        [analysisId],
      );
    }
    const { artifact } = fetched;
    if (artifact.inputHash !== explicitInputHash(doc, analysisCase))
      return fail('EXP_RESULT_STALE', 'the artifact was built for other inputs than the current set-up');
    const expected = explicitSummary(doc, analysisCase, artifact, artifactHash);
    if (typeof expected === 'string') return fail('EXP_SUMMARY_MISMATCH', expected);
    const differing = summary === undefined ? [] : differingKeys(summary, expected);
    if (differing.length > 0)
      return fail('EXP_SUMMARY_MISMATCH', `the summary differs from the one recomputed from the artifact in: ${differing.join(', ')}`);
    const { energy } = expected;
    return changed(
      withSpec(doc, analysisCase, { ...spec, results: expected }),
      `record_explicit_results: ${analysisId} ${expected.termination} termination after ${expected.cycles} cycles to t = ${significantNumber(expected.finalTimeS, 6)} s (min step ${significantNumber(expected.minTimeStepS, 4)} s); energy error ${significantNumber(100 * energy.errorFinal, 3)} %, hourglass/internal max ${significantNumber(energy.hourglassRatioMax, 3)}; max von Mises ${significantNumber(expected.maxVonMises.value, 6)} ${expected.maxVonMises.unit}; ${expected.failedElements} failed element(s) (${expected.solver.name} ${expected.solver.version}, ${expected.solver.device}${expected.solver.deterministic ? ', deterministic' : ''}); review required, not certification evidence${expected.unverified ? '; UNVERIFIED material inputs' : ''}.`,
      [analysisId],
    );
  },
});
