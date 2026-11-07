/** delete_convergence_study and accept_verification_exception (the human gate of PHY-00). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { DOCUMENT_UNIDENTIFIED_TEXT, documentIdentity } from '@core/model/documentUid';
import { humanGate } from '@core/model/humanGate';
import type { StudyException } from '@core/model/convergenceStudy';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { analysisOf, caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { analyseStudy, staleReasons, withLedgerEntry, withStudy, withoutStudy } from './studyState';
import { verifyStudy } from './studyVerify';
import { refuseVnv } from './studyCodes';
import { ACCEPTABLE_CODES, EXCEPTION_ACT, exceptionDetails, levelHashes } from './studyException';

const studyIdSchema = z
  .string()
  .describe('Id of the convergence study (affected[0] of record_convergence_study, e.g. cs-12.1; see check_verification).');

/**
 * @affects doc.analysis.cases[analysisId].studies / studyOrder (removes one study; affected: [studyId])
 * @invariant the case, its mesh and results are untouched
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; unknown study -> VNV_STUDY_NOT_FOUND (refusals, unchanged doc)
 */
export const deleteConvergenceStudy = defineCommand({
  name: 'delete_convergence_study',
  description:
    'Delete one recorded convergence study of an analysis (find ids with check_verification). Use it to drop a stale or superseded study; the ' +
    'analysis, its mesh and results are not changed. Refused with VNV_STUDY_NOT_FOUND for an unknown id. Next: run_convergence_study for a fresh one.',
  params: z.object({ analysisId: analysisIdSchema, studyId: studyIdSchema }),
  run: (doc, { analysisId, studyId }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseFe(doc, 'delete_convergence_study', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    if (analysisCase.studies === undefined || !Object.hasOwn(analysisCase.studies, studyId))
      return refuseVnv(
        doc,
        'delete_convergence_study',
        'VNV_STUDY_NOT_FOUND',
        `no study '${studyId}' in '${analysisId}'`,
        [analysisId, studyId],
        ['studyId'],
      );
    return changed(withoutStudy(doc, analysisCase, studyId), `delete_convergence_study: removed '${studyId}' from '${analysisId}'.`, [
      studyId,
    ]);
  },
});

/**
 * @affects doc.analysis.cases[analysisId].studies[studyId].exception (code, justification, signer, signatureId, signature, level hashes, document uid)
 * @invariant the param is `confirmation` (never reaches the history: execute records { verified: true }); a replay honours a recorded step only from `analysis.exceptionLedger` (kept by replaySeed); recorded only with a signature verified (and spent) by `ctx.humanSignature` over sha256 of (act, study, analysis, code, justification, level
 *   result hashes, document uid, nonce); re-verified by check_verification, so a changed study or a copied document voids it; never changes the numbers
 * @failure no signing port / no signature / a signature that does not verify -> VNV_HUMAN_GATE (an agent always lands here); unknown analysis / study
 *   -> FEA_ANALYSIS_NOT_FOUND / VNV_STUDY_NOT_FOUND; a document without uid -> FEA_DOCUMENT_UNIDENTIFIED; empty justification -> VNV_PARAM_INVALID;
 *   a stale study -> VNV_STUDY_STALE; a code the study does not show, or one that is not acceptable -> VNV_EXCEPTION_NOT_APPLICABLE
 */
export const acceptVerificationException = defineCommand({
  name: 'accept_verification_exception',
  description:
    "Record a qualified reviewer's acceptance of ONE non-converged finding of a convergence study (VNV_NOT_ASYMPTOTIC, VNV_OSCILLATORY, " +
    'VNV_DIVERGENT or VNV_ORDER_MISMATCH) so the study may support a margin anyway. HUMAN GATE. Only a human-held signature over this exact study ' +
    'verifies (09 PLM signing port): an agent has none and always gets VNV_HUMAN_GATE with the document unchanged. Do not retry or work around it: ' +
    'hand the study to the reviewer, who accepts it in the desktop app. The acceptance never changes a number or the GCI, covers only the levels it ' +
    'was signed on, and ends when the study is re-run or the document is copied.',
  params: z.object({
    analysisId: analysisIdSchema,
    studyId: studyIdSchema,
    code: z.enum(ACCEPTABLE_CODES).describe('The finding accepted (as listed by check_verification).'),
    justification: z.string().describe('Mandatory engineering justification (non-empty).'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object (with a nonce field) from the signing port. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, { analysisId, studyId, code, justification, confirmation }, ctx): CommandResult => {
    const fail = (why: string, message: string, ids: readonly string[] = [analysisId, studyId]): CommandResult =>
      refuseVnv(doc, 'accept_verification_exception', why, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseFe(doc, 'accept_verification_exception', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const study =
      analysisCase.studies !== undefined && Object.hasOwn(analysisCase.studies, studyId) ? analysisCase.studies[studyId] : undefined;
    if (study === undefined) return fail('VNV_STUDY_NOT_FOUND', `no study '${studyId}' in '${analysisId}'`);
    // a REPLAY of a recorded step (its confirmation is { verified: true }) is honoured only from the ledger of acceptances a human really signed
    const kept =
      ctx?.replaying === true && isRecordedConfirmation(confirmation)
        ? (analysisOf(doc).exceptionLedger ?? []).find(
            (entry) =>
              entry.analysisId === analysisId &&
              entry.studyId === studyId &&
              entry.code === code &&
              entry.justification === justification &&
              entry.documentUid === documentIdentity(doc) &&
              entry.levelHashes.join() === levelHashes(study).join(),
          )
        : undefined;
    const port = ctx?.humanSignature ?? null;
    if (kept === undefined && (port === null || typeof confirmation !== 'object' || confirmation === null))
      return fail(
        'VNV_HUMAN_GATE',
        'accepting an exception needs a human-held signature: hand the study to the qualified reviewer, do not retry',
      );
    if (doc.uid === undefined)
      return refuseFe(doc, 'accept_verification_exception', 'FEA_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT, [analysisId]);
    if (justification.trim() === '') return fail('VNV_PARAM_INVALID', 'an exception needs a justification');
    if (kept === undefined) {
      const stale = staleReasons(doc, analysisCase, study);
      if (stale.length > 0) return fail('VNV_STUDY_STALE', `${study.id} is stale (${stale.join('; ')}): an exception cannot cover it`);
      if (study.verified === false)
        return fail(
          'VNV_STUDY_UNVERIFIED',
          `${study.id} was recorded without its artifacts: an exception cannot cover numbers nobody verified`,
        );
      const store = ctx?.feaArtifacts ?? null;
      const problem = store === null ? null : verifyStudy(doc, analysisCase, study, store, true);
      if (problem !== null) return fail(problem.code, problem.message, problem.ids);
    }
    const outcome = analyseStudy(study);
    if (!outcome.ok) return fail(outcome.code, outcome.message);
    if (!outcome.analysis.findings.some((finding) => finding.code === code))
      return fail(
        'VNV_EXCEPTION_NOT_APPLICABLE',
        `${study.id} shows no ${code} finding to accept (findings: ${outcome.analysis.findings.map((finding) => finding.code).join(', ') || 'none'})`,
      );
    const gate =
      kept !== undefined
        ? ({ cleared: true, signer: kept.signer, signatureId: kept.signatureId } as const)
        : humanGate(port, EXCEPTION_ACT, [study.id], confirmation, exceptionDetails(study, code, justification, documentIdentity(doc)));
    if (!gate.cleared) return fail('VNV_HUMAN_GATE', gate.reason);
    const exception: StudyException = {
      code,
      justification,
      signer: gate.signer,
      signatureId: gate.signatureId,
      signature: kept === undefined ? confirmation : kept.signature,
      levelHashes: levelHashes(study),
      documentUid: documentIdentity(doc),
    };
    const withException = withStudy(doc, analysisCase, { ...study, exception });
    const accepted = kept !== undefined ? withException : withLedgerEntry(withException, { ...exception, analysisId, studyId });
    return changed(
      accepted,
      `accept_verification_exception: ${code} of '${study.id}' accepted by ${gate.signer} (signature ${gate.signatureId}); the numbers are unchanged.`,
      [study.id],
    );
  },
});
