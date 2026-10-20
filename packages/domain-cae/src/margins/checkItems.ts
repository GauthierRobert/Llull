/** check_analysis items of the margin table (05 §7.1; VC-FEA-62): negative / marginal rows, an unset band, rows pending a human. */

import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { feRemediation } from '../shared/feCodes';
import { caseOf } from '../shared/access';
import { marginTable, type MarginRow } from './computeMargins';

export interface MarginCheckItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (code: string, severity: MarginCheckItem['severity'], message: string, ids: readonly string[]): MarginCheckItem => ({
  code,
  severity,
  ids,
  message,
  remediation: feRemediation(code),
});

const describeRow = (row: MarginRow): string =>
  `${row.rowId} (part ${String(row['part'])}, ${String(row['loadCase'])}, ${String(row['check'])}, MS ${row.ms === null ? 'n/a' : Number(row.ms.toPrecision(4))})`;

/**
 * Margin items of a static / thermo_static case with verified results and margins computable from the material strengths with the DEFAULT
 * query (no explicit allowable, no band): FEA_MS_NEGATIVE (error, always, even after a disposition: a FAIL never becomes a pass),
 * FEA_MARGINAL_BAND_UNSET (warning; without a band no row is MARGINAL, so FEA_MS_MARGINAL is a code of compute_margins rows only),
 * FEA_DISPOSITION_PENDING (warning for FAIL rows without a valid human disposition). Empty when no margin can be computed (stale, unverified, no allowable): the other checks name those problems.
 */
export function marginItems(doc: CadDocument, analysisId: string, ctx: ExecutionContext | undefined): MarginCheckItem[] {
  const band = caseOf(doc, analysisId)?.marginalBand;
  const table = marginTable(doc, analysisId, band === undefined ? {} : { marginalBand: band }, ctx);
  if ('code' in table) return [];
  const items: MarginCheckItem[] = [];
  const failed = table.rows.filter((row) => row.status === 'FAIL');
  const pending = table.rows.filter((row) => row.disposition === 'pending_human');
  if (failed.length > 0)
    items.push(
      item('FEA_MS_NEGATIVE', 'error', `${failed.length} margin row(s) with MS < 0: ${failed.map(describeRow).join('; ')}`, [
        analysisId,
        ...failed.map((row) => row.rowId),
      ]),
    );
  if (band === undefined)
    items.push(
      item(
        'FEA_MARGINAL_BAND_UNSET',
        'warning',
        'no marginalBand is stated, so no row can be MARGINAL: ask the owner for a band and record it with set_margin_band',
        [analysisId],
      ),
    );
  if (pending.length > 0)
    items.push(
      item(
        'FEA_DISPOSITION_PENDING',
        'warning',
        `${pending.length} FAIL row(s) wait for a human disposition: ${pending.map(describeRow).join('; ')}`,
        [analysisId, ...pending.map((row) => row.rowId)],
      ),
    );
  return items;
}
