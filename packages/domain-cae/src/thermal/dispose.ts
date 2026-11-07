/** dispose_thermal_limit: human-gated acceptance of a FAIL / MARGINAL temperature-limit row (PHY-03 FR-THM-23, AF-34). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { DOCUMENT_UNIDENTIFIED_TEXT, documentIdentity } from '@core/model/documentUid';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { keptDisposition, verifiedSigner, withDispositionLedgered } from '../shared/dispositionLedger';
import { analysisIdSchema } from '../shared/schemas';
import { isProblem, thermalCaseOf, withThermal } from './access';
import { refuseThermal } from './codes';
import { dispositionPayload } from './dispositionGate';
import { rowIdOf, type Bound } from './limitRows';
import { resultArtifacts } from './resultsAccess';

const ROW_PATTERN = /^(.+):(max|min)$/;

/**
 * @affects doc.analysis.cases[analysisId].thermal.dispositions[rowId] (records decision, justification, resultsHash, signer, signatureId and the verified signature, so readers can re-verify it)
 * @invariant the param is `confirmation` (never reaches the history: execute records { verified: true }); only with a signature verified by `ctx.humanSignature`
 *   over the payload sha256 of (documentUid, analysisId, rowId, decision, justification, resultsHash) and spent LAST (a refusal never burns it, a retry of a
 *   used one is THM_HUMAN_GATE); the disposition binds to the current results hash and to this document (its uid, recorded with it and re-verified by
 *   check_temperature_limits); a replay honours a recorded step only from `analysis.dispositionLedger` (kept by replaySeed; same case, row, decision,
 *   justification, results and this document's uid, its signature re-verified when a port is installed), spends nothing, and a document with another uid loses it
 * @failure a signature is single-use and its payload has no nonce (signing kind `payload`): once the act is undone, the same signature cannot be spent again, so the reviewer re-signs with the justification reworded;
 *   with NO port a replay trusts the ledger (the record of an act a verified human made here); no port, no confirmation or one that does not verify -> THM_HUMAN_GATE (an agent always lands here); a document without a uid (checked after the port) -> THM_DOCUMENT_UNIDENTIFIED; unknown row -> THM_LIMIT_NOT_FOUND; stale results -> FEA_RESULTS_STALE;
 *   no results -> FEA_RESULTS_MISSING; empty justification -> THM_LIMIT_INVALID (all refusals, unchanged doc)
 */
export const disposeThermalLimit = defineCommand({
  name: 'dispose_thermal_limit',
  description:
    "Record a qualified reviewer's decision (accepted | rejected | redesign) on a FAIL or MARGINAL row of check_temperature_limits " +
    '(rowId "<limitId>:max|min"). HUMAN GATE. Only a human-held signature over the payload verifies (09 PLM signing port): an agent has none and gets ' +
    'THM_HUMAN_GATE with the document unchanged. Do not try to work around it: hand the row over to the reviewer, who dispositions it in the ' +
    'desktop app. The disposition binds to the results hash and ends when the case is solved again.',
  params: z.object({
    analysisId: analysisIdSchema,
    rowId: z.string().describe('Row id from check_temperature_limits, "<limitId>:max" or "<limitId>:min".'),
    decision: z.enum(['accepted', 'rejected', 'redesign']).describe("The reviewer's decision."),
    justification: z.string().describe('Mandatory engineering justification.'),
    confirmation: z
      .unknown()
      .optional()
      .describe(
        'Human signature object from the signing port over the disposition payload. Agents cannot produce one. Never written to the history.',
      ),
  }),
  run: (doc, { analysisId, rowId, decision, justification, confirmation }, ctx): CommandResult => {
    const fail = (
      code: string,
      message: string,
      ids: readonly string[] = [analysisId, rowId],
      paths: readonly string[] = [],
    ): CommandResult => refuseThermal(doc, 'dispose_thermal_limit', code, message, ids, paths);
    const port = ctx?.humanSignature ?? null;
    const replayed = ctx?.replaying === true && isRecordedConfirmation(confirmation);
    if (!replayed && (port === null || confirmation === undefined))
      return fail('THM_HUMAN_GATE', 'dispositions need a human-held signature: hand over to the qualified reviewer, do not retry');
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found.code, found.message, found.ids, found.paths);
    const match = ROW_PATTERN.exec(rowId);
    const limitId = match?.[1] ?? '';
    const bound = (match?.[2] ?? 'max') as Bound;
    const limit = Object.hasOwn(found.thermal.limits, limitId) ? found.thermal.limits[limitId] : undefined;
    if (limit === undefined || limit[bound] === undefined || rowIdOf(limitId, bound) !== rowId)
      return fail('THM_LIMIT_NOT_FOUND', `no limit row '${rowId}' in '${analysisId}'`, [analysisId, rowId], ['rowId']);
    if (justification.trim() === '')
      return fail('THM_LIMIT_INVALID', 'a disposition needs a justification', [analysisId, rowId], ['justification']);
    if (doc.uid === undefined) return fail('THM_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT, [analysisId]);
    const record = found.analysisCase.results;
    const artifacts = resultArtifacts(doc, found, ctx?.feaArtifacts);
    if (
      'code' in artifacts &&
      (artifacts.code === 'FEA_RESULTS_STALE' || artifacts.code === 'FEA_SUMMARY_MISMATCH' || record === undefined)
    )
      return fail(artifacts.code, artifacts.message, artifacts.ids);
    const resultsHash = record?.resultsHash ?? '';
    const payloadFor = (documentUid: string): string =>
      dispositionPayload(analysisId, rowId, decision, justification, resultsHash, documentUid);
    const kept = keptDisposition(doc, ctx, confirmation, {
      act: 'dispose_thermal_limit',
      analysisId,
      rowKey: rowId,
      decision,
      justification,
      resultsHash,
    });
    // verify only (nothing spent): the signature is spent last, once no other refusal can follow
    const signed = verifiedSigner(port, kept, confirmation, payloadFor, documentIdentity(doc));
    if (signed === null)
      return fail('THM_HUMAN_GATE', 'the signature does not verify for this disposition: hand over to the qualified reviewer');
    if (kept === undefined && port?.spend?.(confirmation, payloadFor(documentIdentity(doc))) === false)
      return fail(
        'THM_HUMAN_GATE',
        'the signature does not verify for this disposition (already used): hand over to the qualified reviewer',
      );
    const disposition = {
      decision,
      justification,
      resultsHash,
      signer: signed.signer,
      signatureId: signed.signatureId,
      signature: kept === undefined ? confirmation : kept.signature,
      documentUid: documentIdentity(doc),
    };
    const thermal = { ...found.thermal, dispositions: { ...found.thermal.dispositions, [rowId]: disposition } };
    return changed(
      kept === undefined
        ? withDispositionLedgered(withThermal(doc, found, thermal), {
            ...disposition,
            act: 'dispose_thermal_limit',
            analysisId,
            rowKey: rowId,
          })
        : withThermal(doc, found, thermal),
      `dispose_thermal_limit: '${rowId}' ${decision} by ${signed.signer} (signature ${signed.signatureId}) on results ${resultsHash.slice(0, 12)}.`,
      [rowId],
    );
  },
});
