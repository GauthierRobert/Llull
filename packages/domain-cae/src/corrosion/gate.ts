/** The signed act of accept_corrosion_item and the re-verification of a stored acceptance (a record in the slice proves nothing by itself). */

import type { HumanSignaturePort } from '@core/model/analysis';
import { documentIdentity, boundVerdict } from '@core/model/documentUid';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import type { Acceptance } from './types';

export const ACCEPT_ACT = 'accept or reject a corrosion compatibility item';

export const nonceOf = (signature: unknown): string =>
  typeof signature === 'object' && signature !== null && typeof (signature as { nonce?: unknown }).nonce === 'string'
    ? (signature as { nonce: string }).nonce
    : '';

export const acceptanceDetails = (
  decision: string,
  justification: string,
  fingerprint: string,
  documentUid: string,
): Record<string, unknown> => ({ decision, justification, fingerprint, documentUid });

/** 'ok' = genuine for this document and signer; 'noport' = no signing port, so nothing can be confirmed. */
export type AcceptanceState = 'ok' | 'invalid' | 'foreign' | 'unbound' | 'noport';

/**
 * Whether the stored `acceptance` of `key` is a genuine human signature for THIS document, re-verified through the port over the payload it was
 * signed for (the item fingerprint is public, so it alone proves nothing).
 */
function verdictOf(doc: CadDocument, port: HumanSignaturePort, key: string, acceptance: Acceptance): AcceptanceState {
  const { verdict, signed } = boundVerdict(
    port,
    acceptance.signature,
    acceptance.documentUid === '' ? undefined : acceptance.documentUid,
    documentIdentity(doc),
    (uid) =>
      humanGatePayload(
        ACCEPT_ACT,
        [key],
        acceptanceDetails(acceptance.decision, acceptance.justification, acceptance.fingerprint, uid),
        nonceOf(acceptance.signature),
      ),
  );
  return verdict === 'ok' && (signed === null || signed.signer !== acceptance.signer || signed.signatureId !== acceptance.signatureId)
    ? 'invalid'
    : verdict;
}

/** The acceptance state; never throws: a port that fails on a hostile signature has not confirmed it. */
export function acceptanceState(doc: CadDocument, port: HumanSignaturePort | null, key: string, acceptance: Acceptance): AcceptanceState {
  if (port === null) return 'noport';
  try {
    return verdictOf(doc, port, key, acceptance);
  } catch {
    return 'invalid';
  }
}
