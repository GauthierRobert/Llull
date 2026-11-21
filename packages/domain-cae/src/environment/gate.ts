/** The signed act of approve_environment_deviation and the re-verification of a stored deviation (a record in the slice proves nothing by itself). */

import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { type SignedState, signedState } from '../shared/signedGate';
import type { Deviation } from './types';

export const DEVIATION_ACT = 'approve or reject a space-environment deviation';

export const acceptanceDetails = (
  decision: string,
  justification: string,
  fingerprint: string,
  documentUid: string,
): Record<string, unknown> => ({ decision, justification, fingerprint, documentUid });

/** 'ok' = genuine for this document and signer; 'noport' = no signing port, so nothing can be confirmed. */
export type DeviationState = SignedState;

/** The state of the stored `deviation` of `key` (re-verified through the port over the payload it was signed for); never throws. */
export const deviationState = (doc: CadDocument, port: HumanSignaturePort | null, key: string, deviation: Deviation): DeviationState =>
  signedState(
    doc,
    port,
    {
      act: DEVIATION_ACT,
      ids: [key],
      details: (uid) => acceptanceDetails(deviation.decision, deviation.justification, deviation.fingerprint, uid),
    },
    deviation,
  );
