/** The human acceptance gate of the scan plugin (accept_asbuilt_extraction, accept_registration): verify first, spend last, replay from a ledger (FIX-SIG-REST). */

import type { AcceptanceLedgerEntry, ScanModel } from '@aec/scan/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { DOCUMENT_UNIDENTIFIED_TEXT, documentIdentity } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import { isRecordedConfirmation } from '@lib/withoutConfirmations';
import { refuseScan } from './codes';
import { scanOf } from './model';

/** What a gate needs to decide: the act, the target record and the payload a human signs for it in a given document. */
interface AcceptanceRequest {
  readonly command: AcceptanceLedgerEntry['act'];
  readonly targetId: string;
  /** The payload for a document uid and the signer-chosen nonce of the signature. */
  readonly payloadFor: (documentUid: string, nonce: string) => string;
}

/** The nonce a signature carries (the signer chooses it; it is part of the signed payload), or '' when it has none. */
export const nonceOf = (signature: unknown): string =>
  typeof signature === 'object' && signature !== null && typeof (signature as { nonce?: unknown }).nonce === 'string'
    ? (signature as { nonce: string }).nonce
    : '';

export type Acceptance = {
  readonly signer: string;
  readonly signatureId: string;
  /** The scan with the acceptance ledgered (a replayed acceptance is already in it). */
  readonly ledgered: (scan: ScanModel) => ScanModel;
};

/**
 * Decide an acceptance. Verifies only until every refusal is past, then spends the signature (a refusal never burns it).
 * @invariant the payload binds a signer-chosen nonce (a confirmation without one is refused): the same act can be signed again after an undo, because a fresh nonce is a fresh signature
 *   (the port's spend key is the signature bytes, and Ed25519 is deterministic). A live confirmation must verify through the port over the payload for THIS document; a replayed step (its confirmation is the recorded
 *   `{ verified: true }`) is honoured only from a ledger entry (kept by replaySeed) for the same act, target, payload and this document's uid, re-verified
 *   through the port when one is installed (with NO port the ledger is trusted: it is the record of an act a verified human made on this machine); nothing is spent on a replay
 * @failure no port and no ledger entry, no confirmation, one that does not verify or was already used -> SCN_HUMAN_GATE; a document without uid -> SCN_DOCUMENT_UNIDENTIFIED
 */
export function gateAcceptance(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  confirmation: unknown,
  request: AcceptanceRequest,
): CommandResult | Acceptance {
  const { command, targetId, payloadFor } = request;
  const uid = documentIdentity(doc);
  const port = ctx?.humanSignature ?? null;
  const gate = (message: string): CommandResult => refuseScan(doc, command, 'SCN_HUMAN_GATE', message, [targetId]);
  const kept =
    ctx?.replaying === true && isRecordedConfirmation(confirmation)
      ? (scanOf(doc).acceptanceLedger ?? []).find(
          (entry) =>
            entry.act === command &&
            entry.targetId === targetId &&
            entry.documentUid === uid &&
            entry.payload === payloadFor(uid, nonceOf(entry.signature)),
        )
      : undefined;
  if (kept === undefined && port === null) return gate('no signing port: only a human reviewer can accept');
  if (kept === undefined && nonceOf(confirmation) === '')
    return gate('the confirmation needs a nonce chosen by the signer (part of the signed payload)');
  const signed =
    kept !== undefined
      ? port === null
        ? kept
        : port.verify(kept.signature, payloadFor(kept.documentUid, nonceOf(kept.signature)))
      : port?.verify(confirmation, payloadFor(uid, nonceOf(confirmation)));
  if (
    signed === null ||
    signed === undefined ||
    (kept !== undefined && (signed.signer !== kept.signer || signed.signatureId !== kept.signatureId))
  )
    return gate('the signature did not verify for this record');
  if (doc.uid === undefined) return refuseScan(doc, command, 'SCN_DOCUMENT_UNIDENTIFIED', DOCUMENT_UNIDENTIFIED_TEXT, [targetId]);
  if (kept === undefined && port?.spend?.(confirmation, payloadFor(uid, nonceOf(confirmation))) === false)
    return gate('the signature did not verify for this record (already used)');
  const entry: AcceptanceLedgerEntry = {
    act: command,
    targetId,
    payload: payloadFor(uid, nonceOf(kept === undefined ? confirmation : kept.signature)),
    signer: signed.signer,
    signatureId: signed.signatureId,
    signature: kept === undefined ? confirmation : kept.signature,
    documentUid: uid,
  };
  return {
    signer: signed.signer,
    signatureId: signed.signatureId,
    ledgered: (scan) => (kept === undefined ? { ...scan, acceptanceLedger: [...(scan.acceptanceLedger ?? []), entry] } : scan),
  };
}

/** Whether `gateAcceptance` refused (a result) rather than cleared (an acceptance). */
export const refused = (outcome: CommandResult | Acceptance): outcome is CommandResult => 'document' in outcome;

/** How a stored `accepted` status stands: `verified` (ledger entry that re-verifies), `unverifiable` (entry, but no port here), `unbacked` (no matching entry, or it does not verify). */
export type AcceptanceStanding = 'verified' | 'unverifiable' | 'unbacked';

/**
 * Whether the acceptance of `targetId` is backed by a ledger entry a human really signed, for this document and the record as it is now (pure: nothing is spent).
 * @invariant a planted `status: 'accepted'` without a matching entry that the port verifies is never `verified`
 */
export function acceptanceStanding(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  act: AcceptanceLedgerEntry['act'],
  targetId: string,
  payloadFor: (documentUid: string, nonce: string) => string,
): AcceptanceStanding {
  const uid = documentIdentity(doc);
  const entry = (scanOf(doc).acceptanceLedger ?? []).find(
    (candidate) =>
      candidate.act === act &&
      candidate.targetId === targetId &&
      candidate.documentUid === uid &&
      candidate.payload === payloadFor(uid, nonceOf(candidate.signature)),
  );
  if (entry === undefined) return 'unbacked';
  const port = ctx?.humanSignature ?? null;
  if (port === null) return 'unverifiable';
  const signed = port.verify(entry.signature, payloadFor(uid, nonceOf(entry.signature)));
  return signed !== null && signed.signer === entry.signer && signed.signatureId === entry.signatureId ? 'verified' : 'unbacked';
}
