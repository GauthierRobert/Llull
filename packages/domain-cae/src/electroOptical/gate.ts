/** The signed act of dispose_bond_check and the re-verification of a stored disposition (a record in the slice proves nothing by itself). */

import type { HumanSignaturePort } from '@core/model/analysis';
import { boundVerdict, documentIdentity } from '@core/model/documentUid';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import type { BondDisposition } from './types';

export const DISPOSE_ACT = 'accept, reject or send back for redesign an electrical bond path';

export const nonceOf = (signature: unknown): string =>
  typeof signature === 'object' && signature !== null && typeof (signature as { nonce?: unknown }).nonce === 'string'
    ? (signature as { nonce: string }).nonce
    : '';

export const dispositionDetails = (
  decision: string,
  justification: string,
  inputsHash: string,
  documentUid: string,
): Record<string, unknown> => ({ decision, justification, inputsHash, documentUid });

/** 'ok' = genuine for this document and signer; 'noport' = no signing port, so nothing can be confirmed. */
type DispositionState = 'ok' | 'invalid' | 'foreign' | 'unbound' | 'noport';

function verdictOf(doc: CadDocument, port: HumanSignaturePort, disposition: BondDisposition): DispositionState {
  const { verdict, signed } = boundVerdict(
    port,
    disposition.signature,
    disposition.documentUid === '' ? undefined : disposition.documentUid,
    documentIdentity(doc),
    (uid) =>
      humanGatePayload(
        DISPOSE_ACT,
        [disposition.pathId],
        dispositionDetails(disposition.decision, disposition.justification, disposition.inputsHash, uid),
        nonceOf(disposition.signature),
      ),
  );
  return verdict === 'ok' && (signed === null || signed.signer !== disposition.signer || signed.signatureId !== disposition.signatureId)
    ? 'invalid'
    : verdict;
}

/** The state of a stored disposition; never throws: a port that fails on a hostile signature has not confirmed it. */
export function dispositionState(doc: CadDocument, port: HumanSignaturePort | null, disposition: BondDisposition): DispositionState {
  if (port === null) return 'noport';
  try {
    return verdictOf(doc, port, disposition);
  } catch {
    return 'invalid';
  }
}
