/** dispose_margin: the human gate on a FAIL / MARGINAL margin row (05 §4, §5.8; FR-FEA-33, AF-34, TR-FEA-91). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { analysisInputHash } from '../hash/inputHash';
import { DOCUMENT_UNIDENTIFIED_TEXT, documentIdentity } from '@core/model/documentUid';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { keptDisposition, verifiedSigner, withDispositionLedgered } from '../shared/dispositionLedger';
import { marginDispositionPayload } from './disposition';
import { marginQueryShape, marginTable } from './computeMargins';
import { refuseMarginsAs } from './refusal';

/**
 * @affects doc.analysis.cases[analysisId].dispositions[rowKey] (records decision, justification, resultsHash, signer, signatureId and the verified
 *   signature; affected: [rowKey]); never changes a row's status or the results
 * @invariant the param is `confirmation` (never reaches the history: execute records { verified: true }); recorded only with a signature verified by
 *   `ctx.humanSignature` over sha256 of (analysisId, rowKey, status, ms, decision, justification, resultsHash, documentUid) and spent LAST (a refusal
 *   never burns it, a retry of a used one is FEA_HUMAN_GATE): the decision binds to the row as computed now, to the current results hash and to this document
 *   (its uid, recorded with the disposition and re-verified by compute_margins), and ends when the case is solved again; a replay honours a recorded step
 *   only from `analysis.dispositionLedger` (kept by replaySeed; same case, row, decision, justification, results and this document's uid, its signature
 *   re-verified when a port is installed), spends nothing, and a document with another uid loses it
 * @failure a signature is single-use and its payload has no nonce (signing kind `payload`): once the act is undone, the same signature cannot be spent again, so the reviewer re-signs with the justification reworded;
 *   with NO port a replay trusts the ledger (the record of an act a verified human made here); no signing port, no signature or a signature that does not verify -> FEA_HUMAN_GATE (an agent caller always lands here); unknown analysis
 *   -> FEA_ANALYSIS_NOT_FOUND; a document without a uid (checked after the port and signature) -> FEA_DOCUMENT_UNIDENTIFIED; empty justification -> FEA_PARAM_INVALID; stale / missing results -> FEA_RESULTS_STALE / FEA_RESULTS_MISSING; unknown
 *   rowId -> FEA_MARGIN_ROW_NOT_FOUND; a PASS row -> FEA_MARGIN_PARAM_INVALID (all refusals, unchanged doc)
 */
export const disposeMargin = defineCommand({
  name: 'dispose_margin',
  description:
    "Record a qualified reviewer's decision (accepted | rejected | redesign) on a FAIL or MARGINAL row of compute_margins " +
    '(rowId "r4"; pass the same criterion / allowable / groupBy / loadCases / marginalBand you used there so the row ids match). HUMAN GATE. Only a human-held ' +
    'signature over the row verifies (09 PLM signing port): an agent has none and always gets FEA_HUMAN_GATE with the document unchanged. Do not ' +
    'retry or work around it: hand the row over to the reviewer, who dispositions it in the desktop app. The decision never turns a FAIL into a ' +
    'PASS (the row reads "FAIL (accepted)", status stays FAIL, check_analysis keeps FEA_MS_NEGATIVE) and ends when the analysis is solved again.',
  params: z.object({
    analysisId: analysisIdSchema,
    rowId: z.string().describe('Row id of compute_margins, e.g. "r4" (a FAIL or MARGINAL row).'),
    decision: z.enum(['accepted', 'rejected', 'redesign']).describe("The reviewer's decision."),
    justification: z.string().describe('Mandatory engineering justification (non-empty).'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object from the signing port over the payload of margin_disposition_payload. Agents cannot produce one. Never written to the history.',
      ),
    ...marginQueryShape,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId, rowId, decision, justification, confirmation, ...query } = params;
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId, rowId]): CommandResult =>
      refuseMarginsAs(doc, 'dispose_margin', code, message, ids);
    if (caseOf(doc, analysisId) === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined))
      return fail('FEA_HUMAN_GATE', 'dispositions need a human-held signature: hand over to the qualified reviewer, do not retry');
    if (doc.uid === undefined) return fail('FEA_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT, [analysisId]);
    if (justification.trim() === '') return fail('FEA_PARAM_INVALID', 'a disposition needs a justification');
    const table = marginTable(doc, analysisId, query, ctx);
    if ('code' in table) return fail(table.code, table.message, table.ids);
    const row = table.rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined)
      return fail('FEA_MARGIN_ROW_NOT_FOUND', `no margin row '${rowId}' in '${analysisId}' (${table.rows.length} row(s))`);
    if (row.status === 'NOT_ASSESSED')
      return fail(
        'FEA_MESH_INADEQUATE',
        `row '${rowId}' is not assessed: the mesh of the results is inadequate, so there is no margin to disposition (refine the mesh, or recompute with acceptInadequateMesh: true on the engineer's decision)`,
      );
    if (row.status === 'PASS')
      return fail('FEA_MARGIN_PARAM_INVALID', `row '${rowId}' is PASS: only FAIL and MARGINAL rows are dispositioned`);
    const rowKey = String(row['rowKey']);
    const resultsHash = String(table.data['resultsHash']);
    const subject = { rowKey, status: row.status, ms: row.ms, inputHash: analysisInputHash(doc, analysisId, 'full') };
    const payloadFor = (documentUid: string): string =>
      marginDispositionPayload(analysisId, subject, decision, justification, resultsHash, documentUid);
    const kept = keptDisposition(doc, ctx, confirmation, {
      act: 'dispose_margin',
      analysisId,
      rowKey,
      decision,
      justification,
      resultsHash,
    });
    // verify only (nothing spent): the signature is spent last, once no other refusal can follow
    const signed = verifiedSigner(port, kept, confirmation, payloadFor, documentIdentity(doc));
    if (signed === null)
      return fail('FEA_HUMAN_GATE', 'the signature does not verify for this disposition: hand over to the qualified reviewer');
    if (kept === undefined && port?.spend?.(confirmation, payloadFor(documentIdentity(doc))) === false)
      return fail(
        'FEA_HUMAN_GATE',
        'the signature does not verify for this disposition (already used): hand over to the qualified reviewer',
      );
    const signature = kept === undefined ? confirmation : kept.signature;
    const disposition = {
      decision,
      justification,
      resultsHash,
      signer: signed.signer,
      signatureId: signed.signatureId,
      signature,
      documentUid: documentIdentity(doc),
    };
    const next = { ...table.analysis, dispositions: { ...table.analysis.dispositions, [rowKey]: disposition } };
    return changed(
      kept === undefined
        ? withDispositionLedgered(withCase(doc, next), { ...disposition, act: 'dispose_margin', analysisId, rowKey, signature })
        : withCase(doc, next),
      `dispose_margin: '${rowId}' (${rowKey}) ${row.status} ${decision} by ${signed.signer} (signature ${signed.signatureId}) on results ${resultsHash.slice(0, 12)}; the status stays ${row.status}.`,
      [analysisId],
    );
  },
});
