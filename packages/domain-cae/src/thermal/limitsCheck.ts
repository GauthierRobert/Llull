/** check_temperature_limits: margin of every sourced temperature limit against the solved field (PHY-03 FR-THM-13, FR-THM-22). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { analysisIdSchema } from '../shared/schemas';
import { verifyDisposition } from './dispositionGate';
import { isProblem, thermalCaseOf, type ThermalCase } from './access';
import { item, REVIEW_REASON, type ThermalCheckItem } from './check';
import { refuseThermal } from './codes';
import { limitRows, type LimitRow } from './limitRows';
import { resultArtifacts } from './resultsAccess';
import { unverifiedInputs } from './unverified';

interface RowDisposition {
  readonly disposition: unknown;
  /** The recorded disposition that did not re-verify: the row stays pending_human and says why. */
  readonly unverifiedDisposition?: { readonly decision: string; readonly signer: string; readonly reason: string };
}

/**
 * The disposition of a row: the recorded one only when it was made on the current results AND re-verifies through the signing port against
 * its payload; else pending (FAIL / MARGINAL) or not required. A recorded disposition that fails either test is reported, never counted.
 */
function dispositionOf(
  found: ThermalCase,
  row: LimitRow,
  resultsHash: string,
  port: HumanSignaturePort | null | undefined,
): RowDisposition {
  if (row.status === 'PASS') return { disposition: 'not_required' };
  const recorded = Object.hasOwn(found.thermal.dispositions, row.rowId) ? found.thermal.dispositions[row.rowId] : undefined;
  if (recorded === undefined || recorded.resultsHash !== resultsHash) return { disposition: 'pending_human' };
  const check = verifyDisposition(port, found.analysisCase.id, row.rowId, recorded);
  if (check.valid) return { disposition: recorded };
  return {
    disposition: 'pending_human',
    unverifiedDisposition: { decision: recorded.decision, signer: recorded.signer, reason: check.reason },
  };
}

/**
 * @invariant read-only; every row carries reviewRequired: true and a reason; no limit and no marginal band is ever defaulted; FAIL / MARGINAL
 *   rows are `pending_human` until dispose_thermal_limit records a signed disposition on the same results; a disposition counts only if its
 *   signature re-verifies through `ctx.humanSignature` against the payload, else it is listed as THM_DISPOSITION_UNVERIFIED and the row stays pending
 * @failure unknown analysis / other case type; stale results -> FEA_RESULTS_STALE; no results or artifacts -> FEA_RESULTS_MISSING (refusals)
 */
export const checkTemperatureLimits = defineCommand({
  name: 'check_temperature_limits',
  description:
    'Compare the solved temperatures with the temperature limits of add_temperature_limit: data { rows [{ rowId, limitId, scope, bound ' +
    'max|min, limit, computed, marginK, at (document units), timeS, status PASS|MARGINAL|FAIL, code?, provenance, unverified, ' +
    'reviewRequired: true, reviewReason, disposition }], items, summary }. marginK = limit - T for max (T - limit for min), in K; negative = ' +
    'exceeded (FAIL, THM_LIMIT_EXCEEDED). MARGINAL only when marginalBandK is given (never defaulted: ask the owner or the company rule). ' +
    'FAIL / MARGINAL rows are "pending_human": only a qualified reviewer accepts them (dispose_thermal_limit); a stored disposition counts only ' +
    'when its signature re-verifies against the signing port (otherwise THM_DISPOSITION_UNVERIFIED and the row stays pending). Refused with FEA_RESULTS_STALE ' +
    'after any change since the solve, FEA_RESULTS_MISSING without results. Report the numbers and "computed by llull, not approved".',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    marginalBandK: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Margin band in K below which a passing row is MARGINAL (from the owner or a company rule). Omit for none: THM_MARGINAL_BAND_UNSET is reported.',
      ),
  }),
  run: (doc, { analysisId, marginalBandK }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[]): CommandResult =>
      refuseThermal(doc, 'check_temperature_limits', code, message, ids);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found.code, found.message, found.ids);
    const items: ThermalCheckItem[] = [];
    if (found.thermal.limitOrder.length === 0) {
      items.push(item('THM_NO_LIMITS', 'warning', 'the analysis has no temperature limit', [analysisId]));
      return report(doc, `check_temperature_limits: '${analysisId}' has no temperature limit (add_temperature_limit with a source).`, {
        analysisId,
        rows: [],
        items,
        reviewRequired: true,
        reviewReason: REVIEW_REASON,
        summary: { pass: 0, marginal: 0, fail: 0, pendingHuman: 0 },
      });
    }
    const artifacts = resultArtifacts(doc, found, ctx?.feaArtifacts);
    if ('code' in artifacts) return fail(artifacts.code, artifacts.message, artifacts.ids);
    const rows = limitRows(doc, found, artifacts.mesh, artifacts.results, marginalBandK);
    if ('code' in rows) return fail(rows.code, rows.message, rows.ids);
    const inputs = unverifiedInputs(doc, found);
    const full = rows.map((row) => ({
      ...row,
      unverified: inputs.unverified,
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
      ...dispositionOf(found, row, artifacts.resultsHash, ctx?.humanSignature),
    }));
    if (marginalBandK === undefined)
      items.push(item('THM_MARGINAL_BAND_UNSET', 'warning', 'no marginalBandK given: no row can be MARGINAL', [analysisId]));
    for (const row of full)
      if (row.unverifiedDisposition !== undefined)
        items.push(
          item(
            'THM_DISPOSITION_UNVERIFIED',
            'warning',
            `${row.rowId}: the recorded '${row.unverifiedDisposition.decision}' by ${row.unverifiedDisposition.signer} is not counted: ${row.unverifiedDisposition.reason}`,
            [row.rowId],
          ),
        );
    for (const row of full) {
      if (row.status === 'FAIL')
        items.push(item('THM_LIMIT_EXCEEDED', 'error', `${row.rowId} (${row.name}) ${row.bound}: margin ${row.marginK} K`, [row.rowId]));
      if (row.status === 'MARGINAL')
        items.push(item('THM_LIMIT_MARGINAL', 'warning', `${row.rowId} (${row.name}) ${row.bound}: margin ${row.marginK} K`, [row.rowId]));
    }
    const pending = full.filter((row) => row.disposition === 'pending_human').map((row) => row.rowId);
    if (pending.length > 0)
      items.push(item('THM_DISPOSITION_PENDING', 'warning', `${pending.length} row(s) await a human disposition`, pending));
    const count = (status: string): number => full.filter((row) => row.status === status).length;
    const summary = { pass: count('PASS'), marginal: count('MARGINAL'), fail: count('FAIL'), pendingHuman: pending.length };
    const data = {
      analysisId,
      resultsHash: artifacts.resultsHash,
      rows: full,
      items,
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
      summary,
    };
    return report(
      doc,
      `check_temperature_limits: '${analysisId}' ${summary.fail} FAIL, ${summary.marginal} MARGINAL, ${summary.pass} PASS of ${full.length} row(s); ${pending.length} pending human disposition. ${REVIEW_REASON}.`,
      data,
    );
  },
});
