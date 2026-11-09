/** The signed act of accept_corrosion_item and the re-verification of a stored acceptance (a record in the slice proves nothing by itself). */

import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { type SignedState, signedState } from '../shared/signedGate';
import type { Acceptance } from './types';

export const ACCEPT_ACT = 'accept or reject a corrosion compatibility item';

export const acceptanceDetails = (
  decision: string,
  justification: string,
  fingerprint: string,
  documentUid: string,
): Record<string, unknown> => ({ decision, justification, fingerprint, documentUid });

/** 'ok' = genuine for this document and signer; 'noport' = no signing port, so nothing can be confirmed. */
export type AcceptanceState = SignedState;

/** The acceptance state of the stored `acceptance` of `key` (re-verified through the port over the payload it was signed for); never throws. */
export const acceptanceState = (doc: CadDocument, port: HumanSignaturePort | null, key: string, acceptance: Acceptance): AcceptanceState =>
  signedState(
    doc,
    port,
    {
      act: ACCEPT_ACT,
      ids: [key],
      details: (uid) => acceptanceDetails(acceptance.decision, acceptance.justification, acceptance.fingerprint, uid),
    },
    acceptance,
  );
