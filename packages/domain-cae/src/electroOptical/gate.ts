/** The signed act of dispose_bond_check and the re-verification of a stored disposition (a record in the slice proves nothing by itself). */

import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { type SignedState, signedState } from '../shared/signedGate';
import type { BondDisposition } from './types';

export const DISPOSE_ACT = 'accept, reject or send back for redesign an electrical bond path';

export const dispositionDetails = (
  decision: string,
  justification: string,
  inputsHash: string,
  documentUid: string,
): Record<string, unknown> => ({ decision, justification, inputsHash, documentUid });

/** The state of a stored disposition (re-verified through the port over the payload it was signed for); never throws. */
export const dispositionState = (doc: CadDocument, port: HumanSignaturePort | null, disposition: BondDisposition): SignedState =>
  signedState(
    doc,
    port,
    {
      act: DISPOSE_ACT,
      ids: [disposition.pathId],
      details: (uid) => dispositionDetails(disposition.decision, disposition.justification, disposition.inputsHash, uid),
    },
    disposition,
  );
