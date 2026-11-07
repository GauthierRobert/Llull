/**
 * Human disposition of FAIL / MARGINAL margin rows (05 §5.8, FR-FEA-33, AF-34). A stored disposition is a CLAIM: it counts only when its signature still
 * verifies through the signing port over the row as it is NOW (same row key, margin, status, results hash). It never changes a row's status: a FAIL
 * stays FAIL and reads "FAIL (accepted)".
 */

import type { AnalysisCase, Decision, HumanSignaturePort } from '@core/model/analysis';
import { boundVerdict } from '@core/model/documentUid';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

/** The facts of a row a reviewer signs. */
export interface DispositionSubject {
  readonly rowKey: string;
  readonly status: string;
  readonly ms: number | null;
  /** Full analysis input hash (TR-FEA-06): binds the signature to this model's set-up, so it cannot be replayed into another document whose artifacts are byte-identical. */
  readonly inputHash: string;
}

/** SHA-256 the human signs: the decision on one margin row of one set of results, in the document `documentUid` (VIS-ID). */
export const marginDispositionPayload = (
  analysisId: string,
  subject: DispositionSubject,
  decision: string,
  justification: string,
  resultsHash: string,
  documentUid: string,
): string =>
  sha256Hex(
    canonicalJson({
      kind: 'margin_disposition',
      documentUid,
      analysisId,
      rowKey: subject.rowKey,
      status: subject.status,
      ms: subject.ms,
      inputHash: subject.inputHash,
      decision,
      justification,
      resultsHash,
    }),
  );

export interface RowDisposition {
  /** none (PASS) | pending_human (FAIL / MARGINAL without a valid disposition) | the reviewer's decision. */
  readonly disposition: 'none' | 'pending_human' | Decision;
  /** `FAIL (accepted)` style label; the status itself never changes. */
  readonly statusLabel: string;
  readonly record?: { readonly decision: Decision; readonly justification: string; readonly signer: string; readonly signatureId: string };
  /** Why a stored disposition does not count (stale results, no signing port, signature no longer verifies, made for another document). */
  readonly note?: string;
  /** Set when the stored disposition is a genuine signature made for ANOTHER document (a copied record) or records no document uid. */
  readonly code?: 'FEA_DISPOSITION_FOREIGN_DOCUMENT' | 'FEA_DISPOSITION_UNBOUND';
}

/**
 * Disposition state of one row.
 * @invariant PASS rows are `none`; FAIL / MARGINAL rows are `pending_human` unless a stored disposition binds to the current results hash and its
 *   signature verifies over this row's (rowKey, status, ms) for THIS document (its uid); a record made for another document is `pending_human` with code
 *   FEA_DISPOSITION_FOREIGN_DOCUMENT, one without a recorded uid with FEA_DISPOSITION_UNBOUND; a decision never alters the status
 */
export function dispositionOf(
  analysis: AnalysisCase,
  subject: DispositionSubject,
  port: HumanSignaturePort | null,
  resultsHash: string,
  documentUid: string,
): RowDisposition {
  if (subject.status === 'PASS') return { disposition: 'none', statusLabel: subject.status };
  const pending: RowDisposition = { disposition: 'pending_human', statusLabel: `${subject.status} (pending human disposition)` };
  const stored = Object.hasOwn(analysis.dispositions, subject.rowKey) ? analysis.dispositions[subject.rowKey] : undefined;
  if (stored === undefined) return pending;
  if (stored.resultsHash !== resultsHash)
    return { ...pending, note: 'a disposition exists for results that were since re-solved: it no longer applies' };
  if (port === null) return { ...pending, note: 'no signing port on this machine: the recorded disposition cannot be re-verified' };
  const { verdict, signed } = boundVerdict(port, stored.signature, stored.documentUid, documentUid, (uid) =>
    marginDispositionPayload(analysis.id, subject, stored.decision, stored.justification, stored.resultsHash, uid),
  );
  if (verdict === 'unbound')
    return {
      ...pending,
      code: 'FEA_DISPOSITION_UNBOUND',
      note: 'the recorded disposition records no document uid (signed before signatures were bound to their document): it does not count',
    };
  if (verdict === 'foreign')
    return {
      ...pending,
      code: 'FEA_DISPOSITION_FOREIGN_DOCUMENT',
      note: 'the recorded disposition was signed for another document (copied in): it does not count',
    };
  if (signed === null || signed.signer !== stored.signer || signed.signatureId !== stored.signatureId)
    return { ...pending, note: 'the recorded disposition signature does not verify for this row' };
  return {
    disposition: stored.decision,
    statusLabel: `${subject.status} (${stored.decision})`,
    record: { decision: stored.decision, justification: stored.justification, signer: signed.signer, signatureId: signed.signatureId },
  };
}
