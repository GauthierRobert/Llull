/** The ledger of margin / thermal-limit dispositions a human really signed, and the verify-first / spend-last steps both gates share (FIX-SIG-REST). */

import type { HumanSignaturePort } from '@core/model/analysis';
import type { DispositionLedgerEntry } from '@core/model/dispositionLedger';
import type { ExecutionContext } from '@core/commands/types';
import { documentIdentity } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { analysisOf } from './access';

export type Signer = { readonly signer: string; readonly signatureId: string };

/**
 * The ledger entry a REPLAYED step re-applies: only when the step carries the recorded form of a confirmation and the ledger (kept by replaySeed)
 * holds an entry for the same act, case, row, decision, justification, results and THIS document's uid.
 * @invariant undefined outside a replay or without a matching entry: a replay never invents a disposition
 */
export function keptDisposition(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  confirmation: unknown,
  wanted: Omit<DispositionLedgerEntry, 'signer' | 'signatureId' | 'signature' | 'documentUid'>,
): DispositionLedgerEntry | undefined {
  if (ctx?.replaying !== true || !isRecordedConfirmation(confirmation)) return undefined;
  return (analysisOf(doc).dispositionLedger ?? []).find(
    (entry) =>
      entry.act === wanted.act &&
      entry.analysisId === wanted.analysisId &&
      entry.rowKey === wanted.rowKey &&
      entry.decision === wanted.decision &&
      entry.justification === wanted.justification &&
      entry.resultsHash === wanted.resultsHash &&
      entry.documentUid === documentIdentity(doc),
  );
}

/**
 * The signer of a disposition, verified and NOT spent: a kept entry is re-verified through the port when one is installed (its recorded signature over the
 * payload for its own uid, same signer); a live confirmation is verified over the payload for this document.
 */
export function verifiedSigner(
  port: HumanSignaturePort | null,
  kept: DispositionLedgerEntry | undefined,
  confirmation: unknown,
  payloadFor: (documentUid: string) => string,
  documentUid: string,
): Signer | null {
  if (kept !== undefined) {
    if (port === null) return { signer: kept.signer, signatureId: kept.signatureId };
    const signed = port.verify(kept.signature, payloadFor(kept.documentUid));
    return signed !== null && signed.signer === kept.signer && signed.signatureId === kept.signatureId ? signed : null;
  }
  return port === null ? null : port.verify(confirmation, payloadFor(documentUid));
}

/** `doc` with `entry` appended to the ledger (the case itself is written by the caller). */
export function withDispositionLedgered(doc: CadDocument, entry: DispositionLedgerEntry): CadDocument {
  const model = analysisOf(doc);
  return { ...doc, analysis: { ...model, dispositionLedger: [...(model.dispositionLedger ?? []), entry] } };
}
