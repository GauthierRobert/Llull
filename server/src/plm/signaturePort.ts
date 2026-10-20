/** The signature port of this machine (`ctx.humanSignature`): Ed25519 verification and key trust from the local key store (TR-PLM-07, TR-PLM-19). */

import type { HumanSignaturePort } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { verifyEd25519 } from './ed25519';
import { type KeyStore, createKeyStore } from './keyStore';

/** The three RFC 8032 §7.1 test public keys: published secrets, never trusted outside test mode (TR-PLM-19). */
const RFC8032_TEST_KEYS: ReadonlySet<string> = new Set([
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
]);

/**
 * Port backed by `store`: a key is trusted when registered and not revoked; the RFC 8032 test keys are `test` (refused) unless
 * LLULL_PLM_TEST_KEYS=1, which trusts them (tests only).
 * @invariant `verify` accepts only a signature object { alg: 'Ed25519', publicKey, signature } over the UTF-8 hex payload hash by a trusted key
 */
export function createSignaturePort(store: KeyStore = createKeyStore(), env: NodeJS.ProcessEnv = process.env): HumanSignaturePort {
  const testMode = env['LLULL_PLM_TEST_KEYS'] === '1';
  const trustOf = (publicKey: string): 'trusted' | 'untrusted' | 'test' => {
    if (RFC8032_TEST_KEYS.has(publicKey)) return testMode ? 'trusted' : 'test';
    const record = store.byPublicKey(publicKey);
    return record !== undefined && record.revokedAt === undefined ? 'trusted' : 'untrusted';
  };
  return {
    verifyEd25519,
    keyTrust: trustOf,
    verify(signature, payloadSha256) {
      if (!isRecord(signature) || signature['alg'] !== 'Ed25519') return null;
      const { publicKey, signature: value } = signature;
      if (typeof publicKey !== 'string' || typeof value !== 'string') return null;
      if (trustOf(publicKey) !== 'trusted' || !verifyEd25519(publicKey, payloadSha256, value)) return null;
      const record = store.byPublicKey(publicKey);
      return {
        signer: record?.userId ?? publicKey.slice(0, 16),
        signatureId: `${record?.keyId ?? publicKey.slice(0, 12)}:${value.slice(0, 16)}`,
      };
    },
  };
}
