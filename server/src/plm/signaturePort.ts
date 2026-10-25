/** The signature port of this machine (`ctx.humanSignature`): Ed25519 verification and key trust from the TRUST store (TR-PLM-07, TR-PLM-19). */

import type { HumanSignaturePort } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { verifyEd25519 } from './ed25519';
import { acceptsTestKeys } from './hostConfig';
import { type TrustStore, createTrustStore } from './trustStore';

/** Domain-separation prefix of human-gate signatures: a signature over a manifest can never be replayed as a gate confirmation. */
export const GATE_CONTEXT = 'llull-gate-v1:';

/** The three RFC 8032 §7.1 test public keys: published secrets, trusted only inside a test run that asks for them. */
const RFC8032_TEST_KEYS: ReadonlySet<string> = new Set([
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
]);

/**
 * Port backed by `trust`: a key is trusted only when the desktop app trusted it and it was not revoked. The RFC 8032 test keys are `test` (refused),
 * trusted only when `options.acceptTestKeys` is set by test code (never from an environment variable: they are agent-controlled).
 * @invariant `verify` accepts only { alg: 'Ed25519', publicKey, signature } over GATE_CONTEXT + the payload hash by a trusted key; the signer is the trust record's user
 */
export function createSignaturePort(
  trust: TrustStore = createTrustStore(),
  options: { readonly acceptTestKeys?: boolean } = {},
): HumanSignaturePort {
  const testMode = options.acceptTestKeys ?? acceptsTestKeys();
  const trustOf = (publicKey: string): 'trusted' | 'untrusted' | 'test' => {
    if (RFC8032_TEST_KEYS.has(publicKey)) return testMode ? 'trusted' : 'test';
    return trust.find(publicKey) === null ? 'untrusted' : 'trusted';
  };
  return {
    verifyEd25519,
    keyTrust: trustOf,
    signerOf(publicKey) {
      const record = trust.find(publicKey);
      return record === null ? null : { keyId: record.keyId, userId: record.userId, name: record.name };
    },
    spend(signature, payloadSha256) {
      if (!isRecord(signature) || typeof signature['publicKey'] !== 'string' || typeof signature['signature'] !== 'string') return false;
      return trust.consume(`${signature['publicKey'].slice(0, 16)}:${payloadSha256}:${signature['signature']}`);
    },
    signatureValid(signature, payloadSha256) {
      if (!isRecord(signature) || signature['alg'] !== 'Ed25519') return false;
      const { publicKey, signature: value } = signature;
      return (
        typeof publicKey === 'string' && typeof value === 'string' && verifyEd25519(publicKey, `${GATE_CONTEXT}${payloadSha256}`, value)
      );
    },
    verify(signature, payloadSha256) {
      if (!isRecord(signature) || signature['alg'] !== 'Ed25519') return null;
      const { publicKey, signature: value } = signature;
      if (typeof publicKey !== 'string' || typeof value !== 'string') return null;
      if (trustOf(publicKey) !== 'trusted' || !verifyEd25519(publicKey, `${GATE_CONTEXT}${payloadSha256}`, value)) return null;
      const record = trust.find(publicKey);
      return {
        signer: record?.userId ?? publicKey.slice(0, 16),
        signatureId: `${record?.keyId ?? publicKey.slice(0, 12)}:${value.slice(0, 16)}`,
      };
    },
  };
}
