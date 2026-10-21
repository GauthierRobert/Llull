/** margin_disposition_payload: the SHA-256 a human signs to disposition one margin row (read-only twin of dispose_margin's gate check). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { analysisInputHash } from '../hash/inputHash';
import { marginDispositionPayload } from './disposition';
import { marginQueryShape, marginTable } from './computeMargins';
import { refuseMarginsAs } from './refusal';

/**
 * @affects nothing — read-only; data { payloadSha256, rowKey, status, resultsHash }
 * @invariant the hash is exactly what dispose_margin verifies the signature against for the same params and the current results
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; stale / missing results -> FEA_RESULTS_STALE / FEA_RESULTS_MISSING; unknown rowId ->
 *   FEA_MARGIN_ROW_NOT_FOUND; a PASS row -> FEA_MARGIN_PARAM_INVALID (all refusals, unchanged doc)
 */
export const marginDispositionPayloadQuery = defineCommand({
  name: 'margin_disposition_payload',
  annotations: { readOnly: true },
  description:
    'The SHA-256 a human signs to authorize dispose_margin on one FAIL or MARGINAL row of compute_margins: pass the same analysisId / rowId / ' +
    'decision / justification and the same criterion / allowable / groupBy / loadCases / marginalBand you will send to dispose_margin. The signature ' +
    '(Ed25519 over the UTF-8 hex hash) goes in dispose_margin as signature. Valid only for the current results. An agent cannot sign. Read-only.',
  params: z.object({
    analysisId: analysisIdSchema,
    rowId: z.string().describe('Row id of compute_margins, e.g. "r4" (a FAIL or MARGINAL row).'),
    decision: z.enum(['accepted', 'rejected', 'redesign']).describe("The reviewer's decision."),
    justification: z.string().describe('The engineering justification that will be recorded.'),
    ...marginQueryShape,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId, rowId, decision, justification, ...query } = params;
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId, rowId]): CommandResult =>
      refuseMarginsAs(doc, 'margin_disposition_payload', code, message, ids);
    if (caseOf(doc, analysisId) === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const table = marginTable(doc, analysisId, query, ctx);
    if ('code' in table) return fail(table.code, table.message, table.ids);
    const row = table.rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined)
      return fail('FEA_MARGIN_ROW_NOT_FOUND', `no margin row '${rowId}' in '${analysisId}' (${table.rows.length} row(s))`);
    if (row.status === 'PASS')
      return fail('FEA_MARGIN_PARAM_INVALID', `row '${rowId}' is PASS: only FAIL and MARGINAL rows are dispositioned`);
    const rowKey = String(row['rowKey']);
    const resultsHash = String(table.data['resultsHash']);
    const payloadSha256 = marginDispositionPayload(
      analysisId,
      { rowKey, status: row.status, ms: row.ms, inputHash: analysisInputHash(doc, analysisId, 'full') },
      decision,
      justification,
      resultsHash,
    );
    return report(doc, `Payload to sign for dispose_margin on '${rowId}': sha256 ${payloadSha256}.`, {
      payloadSha256,
      rowKey,
      status: row.status,
      resultsHash,
    });
  },
});
