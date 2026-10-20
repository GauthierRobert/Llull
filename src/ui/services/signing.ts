// Client of the local signing endpoints (server `/signing/*`, 09 PLM): the key store and the Ed25519 keys live on this machine, not in the renderer.

import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';

export interface SigningKey {
  readonly keyId: string;
  readonly userId: string;
  readonly name: string;
  readonly revokedAt?: string;
  /** Whether the desktop app trusted this key (only a trusted key's signature counts). */
  readonly trusted?: boolean;
}

/** The registered, not revoked signing keys of this machine; empty when the backend is unreachable. */
export async function fetchSigningKeys(): Promise<SigningKey[]> {
  try {
    const response = await fetch(`${SERVER_BASE}/signing/keys`, { headers: serverAuthHeaders() });
    const body: unknown = response.ok ? await response.json() : null;
    const keys = isRecord(body) && Array.isArray(body['keys']) ? (body['keys'] as SigningKey[]) : [];
    return keys.filter((key) => key.revokedAt === undefined);
  } catch {
    return [];
  }
}

/**
 * A human-gate confirmation: the key signs the UTF-8 hex `payloadSha256` after the user typed the key passphrase.
 * @failure a wrong passphrase or an unreachable backend -> { error }
 */
export function signPayload(
  keyId: string,
  passphrase: string,
  act: string,
  payloadSha256: string,
): Promise<{ readonly signature: unknown } | { readonly error: string }> {
  return postSign({ kind: 'payload', keyId, passphrase, act, payloadSha256 });
}

/** PMI review signature: the server computes the payload (with a hash of the reviewed items) from the live document. */
export function signPmiReview(
  keyId: string,
  passphrase: string,
  review: { readonly pmiIds: readonly string[]; readonly decision: 'accept' | 'reject'; readonly comment: string },
  nonce: string,
): Promise<{ readonly signature: unknown } | { readonly error: string }> {
  return postSign({ kind: 'pmi_review', keyId, passphrase, nonce, ...review });
}

async function postSign(request: Record<string, unknown>): Promise<{ readonly signature: unknown } | { readonly error: string }> {
  try {
    const response = await fetch(`${SERVER_BASE}/signing/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serverAuthHeaders() },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json();
    if (response.ok && isRecord(body) && body['signature'] !== undefined) return { signature: body['signature'] };
    return { error: isRecord(body) && typeof body['error'] === 'string' ? body['error'] : `signing failed (HTTP ${response.status})` };
  } catch (error) {
    return { error: `signing backend unreachable: ${errorMessage(error)}` };
  }
}
