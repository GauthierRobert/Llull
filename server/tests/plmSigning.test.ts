/** Local signing (09 PLM VC-PLM-17, TR-PLM-07, TR-PLM-19): Ed25519 over node:crypto, the passphrase-protected key store and the signature port. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateEd25519, signEd25519, verifyEd25519 } from '../src/plm/ed25519';
import { createKeyStore } from '../src/plm/keyStore';
import { createSignaturePort } from '../src/plm/signaturePort';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { humanGate } from '@core/model/humanGate';
import { sha256Hex } from '@lib/sha256';
import { reviewWithEco } from '../../tests/unit/plm/fixtures';
import { APPROVALS, T } from '../../tests/unit/plm/fixtures';

interface Vectors {
  rfc8032: { name: string; secretKey: string; publicKey: string; messageHex: string; signature: string }[];
  negative: { name: string; publicKey: string; signature: string; messageHex: string }[];
}
const vectors = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../docs/aerospace/09-plm-configuration-traceability/validation/vectors/ed25519_vectors.json'),
    'utf8',
  ),
) as Vectors;

let keysDir = '';
let env: NodeJS.ProcessEnv = {};
beforeEach(() => {
  keysDir = mkdtempSync(path.join(tmpdir(), 'llull-keys-'));
  env = { ...process.env, LLULL_KEYS_DIR: keysDir };
});
afterEach(() => rmSync(keysDir, { recursive: true, force: true }));

describe('Ed25519 primitives', () => {
  it.each(vectors.rfc8032)('RFC 8032 $name verifies and re-signs deterministically', ({ secretKey, publicKey, messageHex, signature }) => {
    const message = Buffer.from(messageHex, 'hex');
    expect(verifyEd25519(publicKey, message, signature)).toBe(true);
    expect(signEd25519(secretKey, message)).toBe(signature);
  });

  it('rejects every negative vector and malformed input without throwing', () => {
    for (const negative of vectors.negative)
      expect(verifyEd25519(negative.publicKey, Buffer.from(negative.messageHex, 'hex'), negative.signature)).toBe(false);
    expect(verifyEd25519('zz', 'x', 'yy')).toBe(false);
    expect(verifyEd25519('ab'.repeat(32), 'x', 'cd'.repeat(64))).toBe(false);
  });

  it('generates usable key pairs', () => {
    const pair = generateEd25519();
    expect(verifyEd25519(pair.publicKeyHex, 'hello', signEd25519(pair.seedHex, 'hello'))).toBe(true);
    expect(verifyEd25519(pair.publicKeyHex, 'hellp', signEd25519(pair.seedHex, 'hello'))).toBe(false);
  });
});

describe('key store', () => {
  it('creates, lists, signs with the right passphrase only, and revokes', () => {
    const store = createKeyStore(env);
    expect(store.list()).toEqual([]);
    const record = store.create({ userId: 'u-1', name: 'J. Example', passphrase: 'correct horse', at: T });
    expect(store.find(record.keyId)).toEqual(record);
    expect(store.byPublicKey(record.publicKey)?.userId).toBe('u-1');
    const signature = store.sign(record.keyId, 'correct horse', 'message');
    expect(signature).not.toBeNull();
    expect(verifyEd25519(record.publicKey, 'message', signature ?? '')).toBe(true);
    expect(store.sign(record.keyId, 'wrong', 'message')).toBeNull();
    expect(store.sign('k-unknown', 'correct horse', 'message')).toBeNull();
    expect(readFileSync(path.join(keysDir, `${record.keyId}.key.json`), 'utf8')).not.toContain(record.publicKey);
    if (process.platform !== 'win32') expect(statSync(path.join(keysDir, `${record.keyId}.key.json`)).mode & 0o777).toBe(0o600);
    const revoked = store.revoke(record.keyId, T);
    expect(revoked?.revokedAt).toBe(T);
    expect(store.sign(record.keyId, 'correct horse', 'message')).toBeNull();
    expect(store.revoke('k-unknown', T)).toBeNull();
    expect(() => store.create({ userId: 'u', name: 'n', passphrase: '', at: T })).toThrow('passphrase');
  });
});

describe('signature port', () => {
  it('trusts registered keys, refuses unknown, revoked and RFC 8032 test keys outside test mode (TR-PLM-19)', () => {
    const store = createKeyStore(env);
    const record = store.create({ userId: 'u-1', name: 'J', passphrase: 'p', at: T });
    const port = createSignaturePort(store, env);
    const testKey = vectors.rfc8032[0]?.publicKey ?? '';
    expect(port.keyTrust?.(record.publicKey)).toBe('trusted');
    expect(port.keyTrust?.('ab'.repeat(32))).toBe('untrusted');
    expect(port.keyTrust?.(testKey)).toBe('test');
    expect(createSignaturePort(store, { ...env, LLULL_PLM_TEST_KEYS: '1' }).keyTrust?.(testKey)).toBe('trusted');
    store.revoke(record.keyId, T);
    expect(port.keyTrust?.(record.publicKey)).toBe('untrusted');
  });

  it('verifies a human-gate signature over the payload hash and names the signer', () => {
    const store = createKeyStore(env);
    const record = store.create({ userId: 'u-7', name: 'J', passphrase: 'p', at: T });
    const port = createSignaturePort(store, env);
    const payload = sha256Hex('act');
    const signature = { alg: 'Ed25519', publicKey: record.publicKey, signature: store.sign(record.keyId, 'p', payload) };
    expect(port.verify(signature, payload)?.signer).toBe('u-7');
    expect(port.verify(signature, sha256Hex('other'))).toBeNull();
    expect(port.verify({ ...signature, alg: 'RSA' }, payload)).toBeNull();
    expect(port.verify('nope', payload)).toBeNull();
    expect(port.verify({ alg: 'Ed25519', publicKey: 3, signature: 4 }, payload)).toBeNull();
    expect(port.verify({ ...signature, publicKey: 'ab'.repeat(32) }, payload)).toBeNull();
  });

  it('the same port clears the 08 / 05 human gates (one port for every gap)', () => {
    const store = createKeyStore(env);
    const record = store.create({ userId: 'u-7', name: 'J', passphrase: 'p', at: T });
    const port = createSignaturePort(store, env);
    const details = { lowered: [] };
    const payload = sha256Hex(
      // the payload humanGate builds: sha256 of canonical { act, ids sorted, details, nonce }
      '{"act":"lowering an export marking","details":{"lowered":[]},"ids":["m"],"nonce":"n1"}',
    );
    const confirmation = { alg: 'Ed25519', publicKey: record.publicKey, signature: store.sign(record.keyId, 'p', payload), nonce: 'n1' };
    expect(humanGate(port, 'lowering an export marking', ['m'], confirmation, details)).toMatchObject({ cleared: true, signer: 'u-7' });
    expect(humanGate(port, 'lowering an export marking', ['m'], { ...confirmation, nonce: 'n2' }, details)).toMatchObject({
      cleared: false,
    });
  });
});

describe('record_signature with the real port end to end (VC-PLM-17, 26)', () => {
  it('a human signs the iteration manifest, release_item then passes the signature policy, and a forged signature is refused', () => {
    const store = createKeyStore(env);
    const record = store.create({ userId: 'u-1', name: 'J. Example', passphrase: 'p', at: T });
    const port = createSignaturePort(store, env);
    const human = { ...defaultContext(), caller: { kind: 'human' as const }, humanSignature: port };
    const base = reviewWithEco();
    const manifest = execute(base, 'release_manifest', { revision: 'A', kind: 'iteration' }, human).data as { canonical: string };
    const params = {
      target: { kind: 'iteration', ref: 'A.1' },
      alg: 'Ed25519',
      keyId: record.keyId,
      publicKey: record.publicKey,
      signature: store.sign(record.keyId, 'p', manifest.canonical),
      meaning: 'approval',
      signer: { userId: 'u-1', name: 'J. Example' },
      at: T,
    };
    const forged = execute(base, 'record_signature', { ...params, signature: 'ab'.repeat(64) }, human);
    expect(forged.error?.code).toBe('PLM_SIGNATURE_INVALID');
    const signed = execute(base, 'record_signature', params, human).document;
    const strict = { ...signed, plm: { ...signed.plm, policy: { ...signed.plm?.policy, humanSignatureRequired: true } } } as typeof signed;
    const releaseParams = { changeOrder: 'ECO-0100', approvals: APPROVALS, at: T, by: 'u-1' };
    const unsigned = { ...base, plm: { ...base.plm, policy: { ...base.plm?.policy, humanSignatureRequired: true } } } as typeof base;
    expect(execute(unsigned, 'release_item', releaseParams, human).error?.code).toBe('PLM_SIGNATURE_REQUIRED');
    const released = execute(strict, 'release_item', releaseParams, human);
    expect(released.rejected, released.summary).toBeUndefined();
    const verified = execute(released.document, 'verify_release', { revision: 'A' }, human).data as { signaturesValid: unknown };
    expect(verified.signaturesValid).toBe(true);
    store.revoke(record.keyId, T);
    const untrusted = execute(base, 'record_signature', params, human);
    expect(untrusted.error?.code).toBe('PLM_KEY_UNTRUSTED');
  });
});
