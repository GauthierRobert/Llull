/** dispose_margin: the human gate on a FAIL / MARGINAL margin row (05 §4, §5.8; FR-FEA-33, AF-34, TR-FEA-91). */

import type { Disposition } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { analysisInputHash } from '../hash/inputHash';
import { marginDispositionPayload } from './disposition';
import { marginQueryShape, marginTable } from './computeMargins';
import { refuseMarginsAs } from './refusal';

/**
 * @affects doc.analysis.cases[analysisId].dispositions[rowKey] (records decision, justification, resultsHash, signer, signatureId and the verified
 *   signature; affected: [rowKey]); never changes a row's status or the results
 * @invariant recorded only with a signature verified by `ctx.humanSignature` over sha256 of (analysisId, rowKey, status, ms, decision, justification,
 *   resultsHash): the decision binds to the row as computed now and to the current results hash, and ends when the case is solved again
 * @failure no signing port, no signature or a signature that does not verify -> FEA_HUMAN_GATE (an agent caller always lands here); unknown analysis
 *   -> FEA_ANALYSIS_NOT_FOUND; empty justification -> FEA_PARAM_INVALID; stale / missing results -> FEA_RESULTS_STALE / FEA_RESULTS_MISSING; unknown
 *   rowId -> FEA_MARGIN_ROW_NOT_FOUND; a PASS row -> FEA_MARGIN_PARAM_INVALID (all refusals, unchanged doc)
 */
export const disposeMargin = defineCommand({
  name: 'dispose_margin',
  description:
    "HUMAN GATE. Record a qualified reviewer's decision (accepted | rejected | redesign) on a FAIL or MARGINAL row of compute_margins " +
    '(rowId "r4"; pass the same criterion / allowable / groupBy / loadCases / marginalBand you used there so the row ids match). Only a human-held ' +
    'signature over the row verifies (09 PLM signing port): an agent has none and always gets FEA_HUMAN_GATE with the document unchanged. Do not ' +
    'retry or work around it: hand the row over to the reviewer, who dispositions it in the desktop app. The decision never turns a FAIL into a ' +
    'PASS (the row reads "FAIL (accepted)", status stays FAIL, check_analysis keeps FEA_MS_NEGATIVE) and ends when the analysis is solved again.',
  params: z.object({
    analysisId: analysisIdSchema,
    rowId: z.string().describe('Row id of compute_margins, e.g. "r4" (a FAIL or MARGINAL row).'),
    decision: z.enum(['accepted', 'rejected', 'redesign']).describe("The reviewer's decision."),
    justification: z.string().describe('Mandatory engineering justification (non-empty).'),
    signature: z.unknown().optional().describe('Human signature object from the signing port. Agents cannot produce one.'),
    ...marginQueryShape,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId, rowId, decision, justification, signature, ...query } = params;
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId, rowId]): CommandResult =>
      refuseMarginsAs(doc, 'dispose_margin', code, message, ids);
    if (caseOf(doc, analysisId) === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const port = ctx?.humanSignature ?? null;
    if (port === null || signature === undefined)
      return fail('FEA_HUMAN_GATE', 'dispositions need a human-held signature: hand over to the qualified reviewer, do not retry');
    if (justification.trim() === '') return fail('FEA_PARAM_INVALID', 'a disposition needs a justification');
    const table = marginTable(doc, analysisId, query, ctx);
    if ('code' in table) return fail(table.code, table.message, table.ids);
    const row = table.rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined)
      return fail('FEA_MARGIN_ROW_NOT_FOUND', `no margin row '${rowId}' in '${analysisId}' (${table.rows.length} row(s))`);
    if (row.status === 'PASS')
      return fail('FEA_MARGIN_PARAM_INVALID', `row '${rowId}' is PASS: only FAIL and MARGINAL rows are dispositioned`);
    const rowKey = String(row['rowKey']);
    const resultsHash = String(table.data['resultsHash']);
    const signed = port.verify(
      signature,
      marginDispositionPayload(
        analysisId,
        { rowKey, status: row.status, ms: row.ms, inputHash: analysisInputHash(doc, analysisId, 'full') },
        decision,
        justification,
        resultsHash,
      ),
    );
    if (signed === null)
      return fail('FEA_HUMAN_GATE', 'the signature does not verify for this disposition: hand over to the qualified reviewer');
    const disposition: Disposition = {
      decision,
      justification,
      resultsHash,
      signer: signed.signer,
      signatureId: signed.signatureId,
      signature,
    };
    const next = { ...table.analysis, dispositions: { ...table.analysis.dispositions, [rowKey]: disposition } };
    return changed(
      withCase(doc, next),
      `dispose_margin: '${rowId}' (${rowKey}) ${row.status} ${decision} by ${signed.signer} (signature ${signed.signatureId}) on results ${resultsHash.slice(0, 12)}; the status stays ${row.status}.`,
      [analysisId],
    );
  },
});
