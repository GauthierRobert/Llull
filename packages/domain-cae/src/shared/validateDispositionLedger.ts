/** Value validation of the raw `analysis.dispositionLedger` (load path): the margin / thermal-limit dispositions replays re-apply. */

import { isRecord } from '@lib/isRecord';

const ACTS = ['dispose_margin', 'dispose_thermal_limit'];
const DECISIONS = ['accepted', 'rejected', 'redesign'];
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Errors of `analysis.dispositionLedger` (absent: none). */
export function dispositionLedgerErrors(analysis: Record<string, unknown>): string[] {
  const ledger = analysis['dispositionLedger'];
  if (ledger === undefined) return [];
  if (!Array.isArray(ledger)) return ['analysis.dispositionLedger must be a list'];
  return ledger.flatMap((entry, index) => {
    const at = `analysis.dispositionLedger[${index}]`;
    if (!isRecord(entry)) return [`${at} is malformed`];
    const problems: string[] = [];
    if (!ACTS.includes(String(entry['act']))) problems.push(`${at}.act must be one of ${ACTS.join(', ')}`);
    if (!DECISIONS.includes(String(entry['decision']))) problems.push(`${at}.decision must be one of ${DECISIONS.join(', ')}`);
    for (const key of ['analysisId', 'rowKey', 'justification', 'resultsHash', 'signer', 'signatureId'])
      if (!text(entry[key])) problems.push(`${at}.${key} must be text`);
    if (typeof entry['documentUid'] !== 'string') problems.push(`${at}.documentUid must be text`);
    const signature = entry['signature'];
    if (!isRecord(signature) || Object.keys(signature).length === 0) problems.push(`${at}.signature must be a signature object`);
    return problems;
  });
}
