/** The signed payload of a thermal-limit disposition and its re-verification on read (05 §4.1: a stored disposition is a claim). */

import type { Disposition, HumanSignaturePort } from '@core/model/analysis';
import { boundVerdict } from '@core/model/documentUid';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

/** SHA-256 the human signs: the decision on one row of one set of results, in the document `documentUid` (VIS-ID). */
export const dispositionPayload = (
  analysisId: string,
  rowId: string,
  decision: string,
  justification: string,
  resultsHash: string,
  documentUid: string,
): string =>
  sha256Hex(canonicalJson({ kind: 'thermal_limit_disposition', documentUid, analysisId, rowId, decision, justification, resultsHash }));

export type DispositionCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string; readonly code?: 'THM_DISPOSITION_FOREIGN_DOCUMENT' | 'THM_DISPOSITION_UNBOUND' };

/**
 * Whether `recorded` still verifies through the signing port against its own payload.
 * @invariant valid only with a port, a stored signature that the port verifies for (documentUid, analysisId, rowId, decision, justification, resultsHash)
 *   and the same signer / signatureId as recorded; a record without a uid is THM_DISPOSITION_UNBOUND, one signed for another document (copied in)
 *   THM_DISPOSITION_FOREIGN_DOCUMENT; neither is valid
 */
export function verifyDisposition(
  port: HumanSignaturePort | null | undefined,
  analysisId: string,
  rowId: string,
  recorded: Disposition,
  documentUid: string,
): DispositionCheck {
  if (port === null || port === undefined)
    return { valid: false, reason: 'no signing port on this machine: the signature cannot be re-verified' };
  if (recorded.signature === undefined) return { valid: false, reason: 'the disposition carries no signature to verify' };
  const { verdict, signed } = boundVerdict(port, recorded.signature, recorded.documentUid, documentUid, (uid) =>
    dispositionPayload(analysisId, rowId, recorded.decision, recorded.justification, recorded.resultsHash, uid),
  );
  if (verdict === 'unbound')
    return {
      valid: false,
      code: 'THM_DISPOSITION_UNBOUND',
      reason: 'the disposition records no document uid (signed before signatures were bound to their document)',
    };
  if (verdict === 'foreign')
    return {
      valid: false,
      code: 'THM_DISPOSITION_FOREIGN_DOCUMENT',
      reason: 'the disposition was signed for another document (copied in)',
    };
  if (signed === null) return { valid: false, reason: 'the signature does not verify for this disposition' };
  return signed.signer === recorded.signer && signed.signatureId === recorded.signatureId
    ? { valid: true }
    : { valid: false, reason: 'the verified signer does not match the recorded one' };
}
