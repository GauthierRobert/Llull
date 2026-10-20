/** dispose_thermal_limit: human-gated acceptance of a FAIL / MARGINAL temperature-limit row (PHY-03 FR-THM-23, AF-34). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { verifyAndSpend } from '@core/model/humanGate';
import { analysisIdSchema } from '../shared/schemas';
import { isProblem, thermalCaseOf, withThermal } from './access';
import { refuseThermal } from './codes';
import { dispositionPayload } from './dispositionGate';
import { rowIdOf, type Bound } from './limitRows';
import { resultArtifacts } from './resultsAccess';

const ROW_PATTERN = /^(.+):(max|min)$/;

/**
 * @affects doc.analysis.cases[analysisId].thermal.dispositions[rowId] (records decision, justification, resultsHash, signer, signatureId and the verified signature, so readers can re-verify it)
 * @invariant only with a signature verified by `ctx.humanSignature` over the payload sha256 of (analysisId, rowId, decision, justification,
 *   resultsHash); the disposition binds to the current results hash
 * @failure no port or a signature that does not verify -> THM_HUMAN_GATE; unknown row -> THM_LIMIT_NOT_FOUND; stale results -> FEA_RESULTS_STALE;
 *   no results -> FEA_RESULTS_MISSING; empty justification -> THM_LIMIT_INVALID (all refusals, unchanged doc)
 */
export const disposeThermalLimit = defineCommand({
  name: 'dispose_thermal_limit',
  description:
    "HUMAN GATE. Record a qualified reviewer's decision (accepted | rejected | redesign) on a FAIL or MARGINAL row of check_temperature_limits " +
    '(rowId "<limitId>:max|min"). Only a human-held signature over the payload verifies (09 PLM signing port): an agent has none and gets ' +
    'THM_HUMAN_GATE with the document unchanged. Do not try to work around it: hand the row over to the reviewer, who dispositions it in the ' +
    'desktop app. The disposition binds to the results hash and ends when the case is solved again.',
  params: z.object({
    analysisId: analysisIdSchema,
    rowId: z.string().describe('Row id from check_temperature_limits, "<limitId>:max" or "<limitId>:min".'),
    decision: z.enum(['accepted', 'rejected', 'redesign']).describe("The reviewer's decision."),
    justification: z.string().describe('Mandatory engineering justification.'),
    signature: z.unknown().optional().describe('Human signature object from the signing port. Agents cannot produce one.'),
  }),
  run: (doc, { analysisId, rowId, decision, justification, signature }, ctx): CommandResult => {
    const fail = (
      code: string,
      message: string,
      ids: readonly string[] = [analysisId, rowId],
      paths: readonly string[] = [],
    ): CommandResult => refuseThermal(doc, 'dispose_thermal_limit', code, message, ids, paths);
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
    const port = ctx?.humanSignature ?? null;
    if (port === null)
      return fail(
        'THM_HUMAN_GATE',
        'dispositions need a human-held signature and no signing port is available: hand over to the qualified reviewer',
      );
    const record = found.analysisCase.results;
    const artifacts = resultArtifacts(doc, found, ctx?.feaArtifacts);
    if (
      'code' in artifacts &&
      (artifacts.code === 'FEA_RESULTS_STALE' || artifacts.code === 'FEA_SUMMARY_MISMATCH' || record === undefined)
    )
      return fail(artifacts.code, artifacts.message, artifacts.ids);
    const resultsHash = record?.resultsHash ?? '';
    const signed = verifyAndSpend(port, signature, dispositionPayload(analysisId, rowId, decision, justification, resultsHash));
    if (signed === null)
      return fail('THM_HUMAN_GATE', 'the signature does not verify for this disposition: hand over to the qualified reviewer');
    const disposition = { decision, justification, resultsHash, signer: signed.signer, signatureId: signed.signatureId, signature };
    const thermal = { ...found.thermal, dispositions: { ...found.thermal.dispositions, [rowId]: disposition } };
    return changed(
      withThermal(doc, found, thermal),
      `dispose_thermal_limit: '${rowId}' ${decision} by ${signed.signer} (signature ${signed.signatureId}) on results ${resultsHash.slice(0, 12)}.`,
      [rowId],
    );
  },
});
