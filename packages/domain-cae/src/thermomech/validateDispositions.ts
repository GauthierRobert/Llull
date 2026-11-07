/** Value validation of the raw `analysis.fitDispositions` / `analysis.fitLedger` (load path): the human fit dispositions and the ledger replays re-apply them from. */

import { isRecord } from '@lib/isRecord';

const DECISIONS = ['accepted', 'rejected', 'redesign'];
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Problems of one stored disposition record (`rowKey` is checked only for ledger entries). */
function dispositionProblems(entry: unknown, at: string, withRowKey: boolean): string[] {
  if (!isRecord(entry)) return [`${at} is malformed`];
  const problems: string[] = [];
  if (withRowKey && !text(entry['rowKey'])) problems.push(`${at}.rowKey must be text`);
  if (!DECISIONS.includes(String(entry['decision']))) problems.push(`${at}.decision must be one of ${DECISIONS.join(', ')}`);
  for (const key of ['justification', 'inputsHash', 'signer', 'signatureId'])
    if (!text(entry[key])) problems.push(`${at}.${key} must be text`);
  if (typeof entry['documentUid'] !== 'string') problems.push(`${at}.documentUid must be text`);
  const signature = entry['signature'];
  if (!isRecord(signature) || Object.keys(signature).length === 0) problems.push(`${at}.signature must be a signature object`);
  return problems;
}

/** Errors of the fit dispositions and their ledger in a raw analysis slice (both absent: none). */
export function fitDispositionErrors(analysis: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const dispositions = analysis['fitDispositions'];
  if (dispositions !== undefined) {
    if (!isRecord(dispositions)) problems.push('analysis.fitDispositions must be a record');
    else
      for (const [rowKey, entry] of Object.entries(dispositions))
        problems.push(...dispositionProblems(entry, `analysis.fitDispositions['${rowKey}']`, false));
  }
  const ledger = analysis['fitLedger'];
  if (ledger !== undefined) {
    if (!Array.isArray(ledger)) problems.push('analysis.fitLedger must be a list');
    else ledger.forEach((entry, index) => problems.push(...dispositionProblems(entry, `analysis.fitLedger[${index}]`, true)));
  }
  return problems;
}
