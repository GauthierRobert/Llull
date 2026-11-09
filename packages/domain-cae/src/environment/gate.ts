/** Re-verification of a stored environment deviation (a record in the slice proves nothing by itself); local copy of the corrosion gate pattern. */

import type { HumanSignaturePort } from '@core/model/analysis';
import { documentIdentity, boundVerdict } from '@core/model/documentUid';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import type { Deviation } from './types';

export const DEVIATION_ACT = 'approve or reject a space-environment deviation';

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
export type DeviationState = 'ok' | 'invalid' | 'foreign' | 'unbound' | 'noport';

function verdictOf(doc: CadDocument, port: HumanSignaturePort, key: string, deviation: Deviation): DeviationState {
  const { verdict, signed } = boundVerdict(
    port,
    deviation.signature,
    deviation.documentUid === '' ? undefined : deviation.documentUid,
    documentIdentity(doc),
    (uid) =>
      humanGatePayload(
        DEVIATION_ACT,
        [key],
        acceptanceDetails(deviation.decision, deviation.justification, deviation.fingerprint, uid),
        nonceOf(deviation.signature),
      ),
  );
  return verdict === 'ok' && (signed === null || signed.signer !== deviation.signer || signed.signatureId !== deviation.signatureId)
    ? 'invalid'
    : verdict;
}

/** The deviation state; never throws: a port that fails on a hostile signature has not confirmed it. */
export function deviationState(doc: CadDocument, port: HumanSignaturePort | null, key: string, deviation: Deviation): DeviationState {
  if (port === null) return 'noport';
  try {
    return verdictOf(doc, port, key, deviation);
  } catch {
    return 'invalid';
  }
}
