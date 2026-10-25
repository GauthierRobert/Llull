/**
 * Human gate (TR-MAT-51, AF-34): an act only a human may do (export of export-controlled content, lowering a marking). A caller proves it
 * with a signature that the signing port (09 PLM) verifies over the payload hash; a bare `true` from an agent, or no port, refuses.
 */

import { jcsJson } from '../lib/jcs';
import { sha256Hex } from '../lib/sha256';
import type { HumanSignaturePort } from './analysis';

/** Verify AND spend a signature at a mutating gate: the signer, or null when it does not verify or was already used. */
export function verifyAndSpend(
  port: HumanSignaturePort,
  signature: unknown,
  payloadSha256: string,
): { readonly signer: string; readonly signatureId: string } | null {
  const signer = port.verify(signature, payloadSha256);
  return signer === null || port.spend?.(signature, payloadSha256) === false ? null : signer;
}

export type HumanGateOutcome =
  | { readonly cleared: true; readonly signer: string; readonly signatureId: string }
  | { readonly cleared: false; readonly reason: string };

/** The payload a human signs for `act`: the act, the ids it touches, its details (from / to markings, document hash) and the confirmation nonce. */
export const humanGatePayload = (act: string, ids: readonly string[], details: Readonly<Record<string, unknown>>, nonce: string): string =>
  sha256Hex(jcsJson({ act, ids: [...ids].sort(), details, nonce }));

/**
 * Whether `confirmation` clears the gate for `act` on `ids`.
 * @invariant the signed payload is sha256(canonical JSON of { act, ids sorted, details, nonce }): a signature for another act, id set, detail
 *   (markings, document) or without the `nonce` field of the confirmation does not verify
 */
export function humanGate(
  port: HumanSignaturePort | null,
  act: string,
  ids: readonly string[],
  confirmation: unknown,
  details: Readonly<Record<string, unknown>> = {},
): HumanGateOutcome {
  if (confirmation === undefined || confirmation === false)
    return { cleared: false, reason: `${act} needs a human confirmation: pass a signature produced in the desktop app` };
  if (typeof confirmation === 'boolean')
    return { cleared: false, reason: `an agent cannot confirm ${act}; only a human signature verified by the signing port can` };
  if (port === null) return { cleared: false, reason: `no signing port is installed, so ${act} cannot be confirmed` };
  const nonce = typeof confirmation === 'object' && confirmation !== null ? (confirmation as { nonce?: unknown }).nonce : undefined;
  if (typeof nonce !== 'string' || nonce === '')
    return { cleared: false, reason: `the confirmation for ${act} needs a non-empty nonce string` };
  const signer = verifyAndSpend(port, confirmation, humanGatePayload(act, ids, details, nonce));
  return signer === null
    ? { cleared: false, reason: `the signature did not verify for ${act}` }
    : { cleared: true, signer: signer.signer, signatureId: signer.signatureId };
}
