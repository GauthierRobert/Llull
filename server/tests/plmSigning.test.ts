/** Local signing (09 PLM VC-PLM-17, TR-PLM-07, TR-PLM-19): Ed25519, the key store (enrollment), the trust store and the signature port, with attack cases. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateEd25519, signEd25519, verifyEd25519 } from '../src/plm/ed25519';
import { MIN_PASSPHRASE_LENGTH, createKeyStore } from '../src/plm/keyStore';
import { GATE_CONTEXT, createSignaturePort } from '../src/plm/signaturePort';
import { createTrustStore } from '../src/plm/trustStore';
import { verifyAndSpend } from '@core/model/humanGate';
import { accountHome, auditDirectory, configureHostForTests, trustDirectory } from '../src/plm/hostConfig';
import { issueTrustGrant } from '../src/plm/trustGrant';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { humanGate } from '@core/model/humanGate';
import { sha256Hex } from '@lib/sha256';
import { actPayload } from '@plm/gate';
import { approveAll, reviewWithEco } from '../../tests/unit/plm/fixtures';
import { PASSPHRASE, T, type TestHome, testHome, trustedKey } from './plmTestSupport';

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

let home: TestHome;
beforeEach(() => {
  home = testHome();
});
afterEach(() => home.cleanup());

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

describe('key enrollment (not trust)', () => {
  it('enrolls, signs with the right passphrase only, and revokes', async () => {
    const store = createKeyStore(home.env);
    expect(store.list()).toEqual([]);
    const record = await store.create({ userId: 'u-1', name: 'J. Example', passphrase: PASSPHRASE, at: T });
    expect(store.find(record.keyId)).toEqual(record);
    expect(store.byPublicKey(record.publicKey)?.userId).toBe('u-1');
    const signature = await store.sign(record.keyId, PASSPHRASE, 'message');
    expect(verifyEd25519(record.publicKey, 'message', signature ?? '')).toBe(true);
    expect(await store.sign(record.keyId, 'wrong passphrase!', 'message')).toBeNull();
    expect(await store.sign('k-unknown', PASSPHRASE, 'message')).toBeNull();
    expect(await store.sign('../../etc/passwd', PASSPHRASE, 'message')).toBeNull();
    const sealed = JSON.parse(readFileSync(path.join(home.env['LLULL_KEYS_DIR'] as string, `${record.keyId}.key.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(sealed).toMatchObject({ kdf: 'scrypt', N: 131072, r: 8, p: 1 });
    expect(JSON.stringify(sealed)).not.toContain(record.publicKey);
    expect(store.revoke(record.keyId, T)?.revokedAt).toBe(T);
    expect(await store.sign(record.keyId, PASSPHRASE, 'message')).toBeNull();
    expect(store.revoke('k-unknown', T)).toBeNull();
  });

  it('refuses a short passphrase', async () => {
    await expect(
      createKeyStore(home.env).create({ userId: 'u', name: 'n', passphrase: 'x'.repeat(MIN_PASSPHRASE_LENGTH - 1), at: T }),
    ).rejects.toThrow('at least');
  });

  it('a record edited to carry another public key cannot sign (AAD binds the key id and public key) and a swapped seed is detected', async () => {
    const store = createKeyStore(home.env);
    const record = await store.create({ userId: 'u-1', name: 'n', passphrase: PASSPHRASE, at: T });
    const other = await store.create({ userId: 'u-2', name: 'o', passphrase: PASSPHRASE, at: T });
    const registry = path.join(home.env['LLULL_KEYS_DIR'] as string, 'registry.json');
    const records = JSON.parse(readFileSync(registry, 'utf8')) as { keyId: string; publicKey: string }[];
    writeFileSync(
      registry,
      JSON.stringify(records.map((entry) => (entry.keyId === record.keyId ? { ...entry, publicKey: other.publicKey } : entry))),
    );
    expect(await store.sign(record.keyId, PASSPHRASE, 'm')).toBeNull();
    const keyFile = (id: string): string => path.join(home.env['LLULL_KEYS_DIR'] as string, `${id}.key.json`);
    writeFileSync(keyFile(record.keyId), readFileSync(keyFile(other.keyId)));
    writeFileSync(registry, JSON.stringify(records));
    expect(await store.sign(record.keyId, PASSPHRASE, 'm')).toBeNull();
  });
});

describe('trust is separate from enrollment and cannot be minted by an agent', () => {
  it('an enrolled key is untrusted; only a trust grant (issued by the desktop) trusts it', async () => {
    const record = await createKeyStore(home.env).create({ userId: 'u-1', name: 'J', passphrase: PASSPHRASE, at: T });
    const trust = createTrustStore(home.trust);
    const port = createSignaturePort(trust);
    expect(port.keyTrust?.(record.publicKey)).toBe('untrusted');
    expect(port.signerOf?.(record.publicKey)).toBeNull();
    expect(() => trust.trust(record, { userConfirmed: false } as never, T)).toThrow('desktop');
    trust.trust(record, issueTrustGrant('test'), T);
    expect(port.keyTrust?.(record.publicKey)).toBe('trusted');
    expect(port.signerOf?.(record.publicKey)).toMatchObject({ keyId: record.keyId, userId: 'u-1' });
    expect(trust.revoke(record.publicKey, T)).toBe(true);
    expect(trust.revoke(record.publicKey, T)).toBe(false);
    expect(port.keyTrust?.(record.publicKey)).toBe('untrusted');
  });

  it('revokedSignerOf names the user of a REVOKED enrolled key whose signature is genuine, and nobody else', async () => {
    const payload = 'ab'.repeat(32);
    const key = await trustedKey(home, 'u-1');
    const signature = (await key.gate(payload)) ?? '';
    const proof = { alg: 'Ed25519', keyId: key.record.keyId, publicKey: key.record.publicKey, signature, nonce: 'n' };
    const trust = createTrustStore(home.trust);
    const port = createSignaturePort(trust);
    expect(port.revokedSignerOf?.(proof, payload)).toBeNull();
    trust.revoke(key.record.publicKey, T);
    expect(port.revokedSignerOf?.(proof, payload)).toBe('u-1');
    expect(port.revokedSignerOf?.(proof, 'cd'.repeat(32))).toBeNull();
    expect(port.revokedSignerOf?.({ ...proof, alg: 'RSA' }, payload)).toBeNull();
    expect(port.revokedSignerOf?.({ ...proof, publicKey: 3 }, payload)).toBeNull();
    // An unknown key (an agent's own pair) and a published RFC 8032 test key sign validly but have no revoked record.
    const own = generateEd25519();
    const ownProof = {
      alg: 'Ed25519',
      publicKey: own.publicKeyHex,
      signature: signEd25519(own.seedHex, `${GATE_CONTEXT}${payload}`),
      nonce: 'n',
    };
    expect(port.revokedSignerOf?.(ownProof, payload)).toBeNull();
    const testSeed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
    const testProof = {
      alg: 'Ed25519',
      publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      signature: signEd25519(testSeed, `${GATE_CONTEXT}${payload}`),
      nonce: 'n',
    };
    expect(verifyEd25519(testProof.publicKey, `${GATE_CONTEXT}${payload}`, testProof.signature)).toBe(true);
    expect(port.revokedSignerOf?.(testProof, payload)).toBeNull();
  });

  it('LLULL_KEYS_DIR cannot swap the trust store: another keys directory with a self-made key trusts nothing', async () => {
    const mine = await trustedKey(home, 'u-1');
    const attackerEnv = { ...home.env, LLULL_KEYS_DIR: path.join(home.dir, 'attacker-keys') };
    const planted = await createKeyStore(attackerEnv).create({ userId: 'u-1', name: 'J. Example', passphrase: PASSPHRASE, at: T });
    const port = createSignaturePort(createTrustStore());
    expect(port.keyTrust?.(planted.publicKey)).toBe('untrusted');
    expect(port.keyTrust?.(mine.record.publicKey)).toBe('trusted');
  });

  it('no environment variable moves the trust store, accepts test keys or sets a test mode: only in-process test configuration does', async () => {
    const mine = await trustedKey(home, 'u-1');
    const saved = { ...process.env };
    // an agent-controlled environment: TEST=true, a trust directory of its own with a hand-made store, test keys switched on
    process.env['TEST'] = 'true';
    process.env['VITEST'] = '1';
    process.env['LLULL_PLM_TEST_KEYS'] = '1';
    process.env['LLULL_TRUST_DIR'] = path.join(home.dir, 'attacker-trust');
    try {
      const planted = await createKeyStore(home.env).create({ userId: 'u-evil', name: 'evil', passphrase: PASSPHRASE, at: T });
      createTrustStore(path.join(home.dir, 'attacker-trust')).trust(planted, issueTrustGrant('attacker'), T);
      const port = createSignaturePort();
      expect(port.keyTrust?.(planted.publicKey)).toBe('untrusted');
      expect(port.keyTrust?.(vectors.rfc8032[0]?.publicKey ?? '')).toBe('test');
      expect(port.keyTrust?.(mine.record.publicKey)).toBe('trusted');
    } finally {
      for (const name of ['TEST', 'VITEST', 'LLULL_PLM_TEST_KEYS', 'LLULL_TRUST_DIR']) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  it('an edited or unkeyed trust file trusts nothing', async () => {
    const mine = await trustedKey(home, 'u-1');
    const file = path.join(home.trust, 'trust.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { keys: { userId: string }[]; mac: string };
    const planted = await createKeyStore(home.env).create({ userId: 'u-evil', name: 'evil', passphrase: PASSPHRASE, at: T });
    writeFileSync(
      file,
      JSON.stringify({
        ...parsed,
        keys: [...parsed.keys, { keyId: planted.keyId, userId: 'u-evil', name: 'evil', publicKey: planted.publicKey, trustedAt: T }],
      }),
    );
    const port = createSignaturePort(createTrustStore(home.trust));
    expect(port.keyTrust?.(planted.publicKey)).toBe('untrusted');
    expect(port.keyTrust?.(mine.record.publicKey)).toBe('untrusted');
    writeFileSync(file, '{ not json');
    expect(createTrustStore(home.trust).list()).toEqual([]);
    chmodSync(path.join(home.trust, 'trust.secret'), 0o600);
  });

  it('the RFC 8032 test keys are trusted only when test code says so in-process (never from the environment)', () => {
    const testKey = vectors.rfc8032[0]?.publicKey ?? '';
    const trust = createTrustStore(home.trust);
    expect(createSignaturePort(trust, { acceptTestKeys: true }).keyTrust?.(testKey)).toBe('trusted');
    expect(createSignaturePort(trust, { acceptTestKeys: false }).keyTrust?.(testKey)).toBe('test');
    expect(createSignaturePort(trust).keyTrust?.(testKey)).toBe('test');
  });
});

describe('signature port', () => {
  it('verifies a human-gate signature over the context-prefixed payload and names the signer from the trust record', async () => {
    const mine = await trustedKey(home, 'u-7');
    const port = createSignaturePort(createTrustStore(home.trust));
    const payload = sha256Hex('act');
    const confirmation = { alg: 'Ed25519', publicKey: mine.record.publicKey, signature: await mine.gate(payload) };
    expect(port.verify(confirmation, payload)?.signer).toBe('u-7');
    expect(port.verify(confirmation, sha256Hex('other'))).toBeNull();
    expect(port.verify({ ...confirmation, signature: await mine.raw(payload) }, payload)).toBeNull();
    expect(port.verify({ ...confirmation, alg: 'RSA' }, payload)).toBeNull();
    expect(port.verify('nope', payload)).toBeNull();
    expect(port.verify({ alg: 'Ed25519', publicKey: 3, signature: 4 }, payload)).toBeNull();
    expect(port.verify({ ...confirmation, publicKey: 'ab'.repeat(32) }, payload)).toBeNull();
    expect(GATE_CONTEXT).toBe('llull-gate-v1:');
  });

  it('a signature is single-use: resent, replayed after an undo or presented to a fresh port it is refused', async () => {
    const mine = await trustedKey(home, 'u-7');
    const payload = sha256Hex('act-once');
    const confirmation = { alg: 'Ed25519', publicKey: mine.record.publicKey, signature: await mine.gate(payload) };
    const fresh = (): ReturnType<typeof createSignaturePort> => createSignaturePort(createTrustStore(home.trust));
    // verify is PURE: stored dispositions are re-checked with it again and again
    expect(fresh().verify(confirmation, payload)?.signer).toBe('u-7');
    expect(fresh().verify(confirmation, payload)?.signer).toBe('u-7');
    // only a mutating gate spends: the first spend works, every later one (resend, undo, another port) is refused
    expect(fresh().spend?.(confirmation, payload)).toBe(true);
    expect(fresh().spend?.(confirmation, payload)).toBe(false);
    expect(verifyAndSpend(fresh(), confirmation, payload)).toBeNull();
    expect(fresh().verify(confirmation, payload)?.signer).toBe('u-7');
    const again = { ...confirmation, signature: await mine.gate(sha256Hex('act-twice')) };
    expect(verifyAndSpend(fresh(), again, sha256Hex('act-twice'))?.signer).toBe('u-7');
  });

  it('the account home comes from the OS user database: HOME, USERPROFILE and LLULL_HOME cannot relocate trust or audit', () => {
    const saved = { ...process.env };
    configureHostForTests({});
    try {
      const real = trustDirectory();
      process.env['HOME'] = path.join(home.dir, 'evil');
      process.env['USERPROFILE'] = path.join(home.dir, 'evil');
      process.env['LLULL_HOME'] = path.join(home.dir, 'evil');
      expect(trustDirectory()).toBe(real);
      expect(auditDirectory()).toBe(path.join(accountHome(), '.llull', 'audit'));
      expect(real.startsWith(path.join(home.dir, 'evil'))).toBe(false);
    } finally {
      for (const name of ['HOME', 'USERPROFILE', 'LLULL_HOME']) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      configureHostForTests({ trustDir: home.trust, auditDir: home.audit });
    }
  });

  it('the same port clears the 08 / 05 human gates (one port for every gap)', async () => {
    const mine = await trustedKey(home, 'u-7');
    const port = createSignaturePort(createTrustStore(home.trust));
    const details = { lowered: [] };
    const payload = sha256Hex('{"act":"lowering an export marking","details":{"lowered":[]},"ids":["m"],"nonce":"n1"}');
    const confirmation = { alg: 'Ed25519', publicKey: mine.record.publicKey, signature: await mine.gate(payload), nonce: 'n1' };
    expect(humanGate(port, 'lowering an export marking', ['m'], confirmation, details)).toMatchObject({ cleared: true, signer: 'u-7' });
    expect(humanGate(port, 'lowering an export marking', ['m'], { ...confirmation, nonce: 'n2' }, details)).toMatchObject({
      cleared: false,
    });
  });
});

describe('the real gate end to end (VC-PLM-17, 26)', () => {
  it('a trusted key releases; an enrolled-only key, a foreign act and a missing signature do not', async () => {
    const mine = await trustedKey(home, 'u-1');
    const stranger = await createKeyStore(home.env).create({ userId: 'u-2', name: 'S', passphrase: PASSPHRASE, at: T });
    const port = createSignaturePort(createTrustStore(home.trust));
    const ctx = { ...defaultContext(), humanSignature: port };
    const doc = approveAll(reviewWithEco());
    const params = { changeOrder: 'ECO-0100', at: T };
    const nonce = 'nonce-real-1';
    const confirmationOf = async (
      key: { record: { keyId: string; publicKey: string }; gate: (p: string) => Promise<string | null> },
      payload: string,
    ): Promise<Record<string, unknown>> => ({
      alg: 'Ed25519',
      keyId: key.record.keyId,
      publicKey: key.record.publicKey,
      signature: await key.gate(payload),
      nonce,
    });
    const payload = actPayload(doc, 'release_item', params, nonce);
    const viaCommand = execute(doc, 'plm_act_payload', { command: 'release_item', params, nonce }, ctx).data as { payloadSha256: string };
    expect(viaCommand.payloadSha256).toBe(payload);

    expect(execute(doc, 'release_item', params, ctx).error?.code).toBe('PLM_HUMAN_GATE');
    const untrusted = {
      record: stranger,
      gate: (p: string) => createKeyStore(home.env).sign(stranger.keyId, PASSPHRASE, `${GATE_CONTEXT}${p}`),
    };
    expect(execute(doc, 'release_item', { ...params, confirmation: await confirmationOf(untrusted, payload) }, ctx).error?.code).toBe(
      'PLM_HUMAN_GATE',
    );
    const foreign = actPayload(doc, 'record_approval', { role: 'checker' }, nonce);
    expect(execute(doc, 'release_item', { ...params, confirmation: await confirmationOf(mine, foreign) }, ctx).error?.code).toBe(
      'PLM_HUMAN_GATE',
    );
    const released = execute(doc, 'release_item', { ...params, confirmation: await confirmationOf(mine, payload) }, ctx);
    expect(released.rejected, released.summary).toBeUndefined();
    expect(released.document.plm?.item.revisions['A']).toMatchObject({ state: 'released', releasedBy: 'u-1' });
  });

  it('a signature over a release manifest is recorded with the signer of the trusted key record, and verify_release re-verifies it', async () => {
    const mine = await trustedKey(home, 'u-1', 'J. Example');
    const ctx = { ...defaultContext(), humanSignature: createSignaturePort(createTrustStore(home.trust)) };
    const doc = (await import('../../tests/unit/plm/fixtures')).released();
    const manifest = execute(doc, 'release_manifest', { revision: 'A', meaning: 'release' }, ctx).data as { canonical: string };
    const params = {
      target: { kind: 'release', ref: 'A' },
      alg: 'Ed25519',
      keyId: 'k-claimed',
      publicKey: mine.record.publicKey,
      signature: await mine.raw(manifest.canonical),
      meaning: 'release',
      signer: { userId: 'u-boss', name: 'Boss' },
      at: T,
    };
    const signed = execute(doc, 'record_signature', params, ctx);
    expect(signed.document.plm?.item.revisions['A']?.signatures[0]).toMatchObject({
      keyId: mine.record.keyId,
      signer: { userId: 'u-1', name: 'J. Example' },
    });
    expect(execute(signed.document, 'verify_release', { revision: 'A' }, ctx).data).toMatchObject({ signaturesValid: true });
    const asReview = execute(doc, 'record_signature', { ...params, meaning: 'review' }, ctx);
    expect(asReview.error?.code).toBe('PLM_SIGNATURE_INVALID');
    await createKeyStore(home.env).revoke(mine.record.keyId, T);
    createTrustStore(home.trust).revoke(mine.record.publicKey, T);
    expect(execute(doc, 'record_signature', params, ctx).error?.code).toBe('PLM_KEY_UNTRUSTED');
  });
});
