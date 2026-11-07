/** record_convergence_study: store a convergence study that the host transport ran, validated against the artifact store (PHY-00 TR-VNV-09). */

import { nextId } from '@lib/id';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { NamedValue } from '@core/model/topology';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { FS_THREE, percent } from './convergenceAnalysis';
import { formalOrderDefault, isQuantityProblem, studyQuantityShape, toStudyQuantity } from './studyQuantity';
import { toStudyLevel, studyLevelShape } from './studySchemas';
import { analyseStudy, staleReasons, withStudy, type CaseStudy } from './studyState';
import { refuseVnv } from './studyCodes';
import { verifyStudy } from './studyVerify';

/** Same text for every refusal: the studies are produced by the transport, never typed. */
const NOTE =
  'Exactly the study returned by run_convergence_study (never hand-written): every level is re-derived from the artifact store and compared.';

/**
 * @affects doc.analysis.cases[analysisId].studies / studyOrder (adds `cs-<step>.<k>`; affected: [studyId])
 * @invariant with an artifact store: every level's mesh and results exist, hash to their names, bind to each other and to the level inputs; while the
 *   study is current each level's element count, h, value and unit equal the ones re-derived from the artifacts and the measure is the finest mesh volume;
 *   a study of an older set-up is recorded STALE as given; WITHOUT a store (replay on another machine) it is kept flagged `verified: false`;
 *   the report is never taken from params (it is recomputed from the levels on every read); Fs and the formal order are named values
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; a hash absent from the store -> VNV_ARTIFACT_NOT_FOUND (live; during a replay the study is kept `verified: false`); any recorded number differing from the
 *   artifacts -> VNV_SUMMARY_MISMATCH; malformed levels -> VNV_LEVELS_INVALID; spacing ratio < 1.1 -> VNV_RATIO_TOO_SMALL; order iteration not
 *   converged -> VNV_ORDER_NOT_CONVERGED; unreadable quantity -> VNV_QUANTITY_UNAVAILABLE (all refusals, unchanged doc)
 */
export const recordConvergenceStudy = defineCommand({
  name: 'record_convergence_study',
  description:
    'Record a mesh-convergence study of one analysis result, as produced by the host transport run_convergence_study (it re-meshes and re-solves ' +
    'the analysis at 3 to 6 mesh sizes and passes its result here). Not for hand use: every level is re-derived from the stored mesh and results ' +
    'artifacts and refused unless it matches exactly, so numbers cannot be invented: VNV_ARTIFACT_NOT_FOUND (a hash is not in the artifact store), ' +
    'VNV_SUMMARY_MISMATCH (a value, spacing or count differs from the artifacts). The observed order, Richardson value and GCI are never taken from ' +
    'the params: read them with check_verification. A study run for an older set-up is recorded STALE (check_verification reports it). Levels are finest first.',
  params: z.object({
    analysisId: analysisIdSchema,
    study: z
      .object({
        quantity: studyQuantityShape,
        unit: z.string().describe("Unit of every level value, e.g. 'mm', 'MPa', 'Hz'."),
        ratio: z
          .number()
          .gt(1)
          .describe('Nominal mesh-size ratio between consecutive levels (informative; the GCI uses the measured spacings).'),
        measure: z
          .object({
            value: z.number().positive().describe('Volume of the finest mesh, analysis length unit cubed.'),
            dimension: z.literal(3).describe('3: the spacing is (volume / elements)^(1/3).'),
          })
          .describe('The domain measure behind every level spacing h.'),
        levels: z.array(studyLevelShape).min(3).max(6).describe('3 to 6 levels, finest first (smallest h first).'),
        formalOrder: z
          .number()
          .positive()
          .optional()
          .describe('Formal order of the method for the quantity. Default: the textbook table of the element order (named default).'),
        safetyFactor: z.number().positive().optional().describe('GCI safety factor Fs. Default 1.25 (named).'),
      })
      .describe(NOTE),
  }),
  run: (doc, { analysisId, study: given }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId], paths: readonly string[] = []): CommandResult =>
      refuseVnv(doc, 'record_convergence_study', code, message, ids, paths);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseFe(doc, 'record_convergence_study', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const quantity = toStudyQuantity(given.quantity);
    if (isQuantityProblem(quantity)) return fail(quantity.code, quantity.message, [analysisId], ['study.quantity']);
    const levels = given.levels.map((level, index) => toStudyLevel(level, index));
    for (const [index, level] of levels.entries()) {
      const previous = levels[index - 1];
      if (previous !== undefined && !(level.h > previous.h))
        return fail(
          'VNV_LEVELS_INVALID',
          `levels must be finest first with strictly increasing h (level ${index} h ${level.h} <= ${previous.h})`,
          [analysisId],
          [`study.levels.${index}.h`],
        );
    }
    const finest = levels[0];
    if (finest === undefined) return fail('VNV_LEVELS_INVALID', 'no level', [analysisId], ['study.levels']);
    const formalOrder: NamedValue | undefined =
      given.formalOrder !== undefined
        ? { value: given.formalOrder, source: 'caller', defaulted: false }
        : formalOrderDefault(analysisCase, quantity, finest.controls.order);
    const safetyFactor: NamedValue =
      given.safetyFactor !== undefined
        ? { value: given.safetyFactor, source: 'caller', defaulted: false }
        : { ...FS_THREE, defaulted: true };
    const port = ctx?.feaArtifacts ?? null;
    const draft: CaseStudy = {
      id: 'pending',
      analysisId,
      quantity,
      unit: given.unit,
      refinement: 'h',
      ratio: given.ratio,
      measure: given.measure,
      levels,
      ...(formalOrder !== undefined ? { formalOrder } : {}),
      safetyFactor,
      ...(port === null ? { verified: false as const } : {}),
    };
    const outcome = analyseStudy(draft);
    if (!outcome.ok) return fail(outcome.code, outcome.message, [analysisId], [`study.levels`]);
    const stale = staleReasons(doc, analysisCase, draft);
    const problem = port === null ? null : verifyStudy(doc, analysisCase, draft, port, stale.length === 0);
    // an absent artifact is not a disproved one: the store is an evictable cache, so a REPLAY keeps the study unverified (named below); a live call refuses
    const evicted = problem !== null && problem.code === 'VNV_ARTIFACT_NOT_FOUND' && ctx?.replaying === true;
    if (problem !== null && !evicted) return fail(problem.code, problem.message, problem.ids, ['study']);
    const recorded: CaseStudy = { ...draft, id: nextId('cs'), ...(evicted ? { verified: false as const } : {}) };
    const { summaryReport: report } = outcome.analysis;
    const head = `record_convergence_study: '${recorded.id}' on '${analysisId}' — ${levels.length} levels, h ${levels.map((level) => level.h.toPrecision(4)).join(' / ')}`;
    const numbers =
      report.status === 'monotone' && report.p !== undefined && report.gci21Fine !== undefined && report.extrapolated !== undefined
        ? `${report.status}, observed order ${report.p.toPrecision(4)}, extrapolated ${report.extrapolated.toPrecision(6)} ${recorded.unit}, estimated discretisation error (GCI, Fs ${safetyFactor.value}) ${percent(report.gci21Fine)}`
        : `${report.status}, no extrapolated value (${outcome.analysis.findings.map((finding) => finding.code).join(', ') || 'none'})`;
    const state = evicted
      ? ` Recorded UNVERIFIED (VNV_ARTIFACT_NOT_FOUND on replay: ${problem?.message}): no number is used until run_convergence_study is run on this machine.`
      : port === null
        ? ' Recorded UNVERIFIED (no artifact store here): no number is used until run_convergence_study is run on this machine.'
        : stale.length > 0
          ? ` Recorded STALE (${stale.join('; ')}): re-run run_convergence_study.`
          : '';
    return changed(withStudy(doc, analysisCase, recorded), `${head}: ${numbers}.${state}`, [recorded.id]);
  },
});
