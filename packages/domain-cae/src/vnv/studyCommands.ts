/** delete_convergence_study and accept_verification_exception (the human gate of PHY-00). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { DOCUMENT_UNIDENTIFIED_TEXT, documentIdentity } from '@core/model/documentUid';
import { humanGate } from '@core/model/humanGate';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { analyseStudy, staleReasons, withStudy, withoutStudy } from './studyState';
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
 * @invariant recorded only with a signature verified (and spent) by `ctx.humanSignature` over sha256 of (act, study, analysis, code, justification, level
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
    signature: z
      .unknown()
      .optional()
      .describe('Human signature object (with a nonce field) from the signing port. Agents cannot produce one.'),
  }),
  run: (doc, { analysisId, studyId, code, justification, signature }, ctx): CommandResult => {
    const fail = (why: string, message: string, ids: readonly string[] = [analysisId, studyId]): CommandResult =>
      refuseVnv(doc, 'accept_verification_exception', why, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseFe(doc, 'accept_verification_exception', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const study =
      analysisCase.studies !== undefined && Object.hasOwn(analysisCase.studies, studyId) ? analysisCase.studies[studyId] : undefined;
    if (study === undefined) return fail('VNV_STUDY_NOT_FOUND', `no study '${studyId}' in '${analysisId}'`);
    const port = ctx?.humanSignature ?? null;
    if (port === null || typeof signature !== 'object' || signature === null)
      return fail(
        'VNV_HUMAN_GATE',
        'accepting an exception needs a human-held signature: hand the study to the qualified reviewer, do not retry',
      );
    if (doc.uid === undefined)
      return refuseFe(doc, 'accept_verification_exception', 'FEA_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT, [analysisId]);
    if (justification.trim() === '') return fail('VNV_PARAM_INVALID', 'an exception needs a justification');
    const stale = staleReasons(doc, analysisCase, study);
    if (stale.length > 0) return fail('VNV_STUDY_STALE', `${study.id} is stale (${stale.join('; ')}): an exception cannot cover it`);
    const outcome = analyseStudy(study);
    if (!outcome.ok) return fail(outcome.code, outcome.message);
    if (!outcome.analysis.findings.some((finding) => finding.code === code))
      return fail(
        'VNV_EXCEPTION_NOT_APPLICABLE',
        `${study.id} shows no ${code} finding to accept (findings: ${outcome.analysis.findings.map((finding) => finding.code).join(', ') || 'none'})`,
      );
    const gate = humanGate(port, EXCEPTION_ACT, [study.id], signature, exceptionDetails(study, code, justification, documentIdentity(doc)));
    if (!gate.cleared) return fail('VNV_HUMAN_GATE', gate.reason);
    const accepted = {
      ...study,
      exception: {
        code,
        justification,
        signer: gate.signer,
        signatureId: gate.signatureId,
        signature,
        levelHashes: levelHashes(study),
        documentUid: documentIdentity(doc),
      },
    };
    return changed(
      withStudy(doc, analysisCase, accepted),
      `accept_verification_exception: ${code} of '${study.id}' accepted by ${gate.signer} (signature ${gate.signatureId}); the numbers are unchanged.`,
      [study.id],
    );
  },
});
