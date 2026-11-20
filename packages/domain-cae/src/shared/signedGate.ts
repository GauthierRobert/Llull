/**
 * Re-verification of a stored human signature (shared by the corrosion acceptance and the electro-optical disposition gates): the signature was made over
 * sha256(act, ids, details, nonce) for ONE document; a record in the slice proves nothing by itself, so every read re-verifies it through the signing port.
 */

import type { HumanSignaturePort } from '@core/model/analysis';
import { boundVerdict, documentIdentity } from '@core/model/documentUid';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import { noop } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';

/** The nonce field of a confirmation object, or ''. */
export const nonceOf = (signature: unknown): string =>
  typeof signature === 'object' && signature !== null && typeof (signature as { nonce?: unknown }).nonce === 'string'
    ? (signature as { nonce: string }).nonce
    : '';

/** What a stored record holds of its signature. */
export interface StoredSignature {
  readonly signature: unknown;
  readonly signer: string;
  readonly signatureId: string;
  readonly documentUid: string;
}

/** The act a stored record was signed for. `details(uid)` builds the signed details for the document uid the record names. */
export interface SignedAct {
  readonly act: string;
  readonly ids: readonly string[];
  readonly details: (documentUid: string) => Record<string, unknown>;
}

/** 'ok' = genuine for this document and signer; 'noport' = no signing port, so nothing can be confirmed. */
export type SignedState = 'ok' | 'invalid' | 'foreign' | 'unbound' | 'noport';

function verdictOf(doc: CadDocument, port: HumanSignaturePort, signed: SignedAct, stored: StoredSignature): SignedState {
  const { verdict, signed: who } = boundVerdict(
    port,
    stored.signature,
    stored.documentUid === '' ? undefined : stored.documentUid,
    documentIdentity(doc),
    (uid) => humanGatePayload(signed.act, signed.ids, signed.details(uid), nonceOf(stored.signature)),
  );
  return verdict === 'ok' && (who === null || who.signer !== stored.signer || who.signatureId !== stored.signatureId) ? 'invalid' : verdict;
}

/**
 * The state of a stored signature.
 * @invariant pure (nothing is spent); never throws: a port that fails on a hostile signature has not confirmed it ('invalid')
 */
export function signedState(doc: CadDocument, port: HumanSignaturePort | null, signed: SignedAct, stored: StoredSignature): SignedState {
  if (port === null) return 'noport';
  try {
    return verdictOf(doc, port, signed, stored);
  } catch {
    return 'invalid';
  }
}

/**
 * The result of a REPLAYED signed step (recorded `{ verified: true }`) when the slice holds no record for its subject: the replay seed dropped it
 * (its step was suppressed or deleted, then regenerated) or a later step removed the subject. Nothing is re-applied and nothing fails: the
 * decision stays pending until a human signs again (SIG-REPLAY). A kept record that disagrees with the step is still the gate's refusal.
 * @invariant returns `doc` unchanged (an inert step)
 */
export function notReapplied(doc: CadDocument, command: string, subject: string): CommandResult {
  return noop(
    doc,
    `${command}: '${subject}' not re-applied: no signed record of it is kept in this document (its step was suppressed or deleted, or the subject removed); the decision stays pending until a human signs again.`,
  );
}
