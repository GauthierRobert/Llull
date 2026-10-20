/** Key trust is a desktop user action (09 PLM TR-PLM-19): Electron-free, with an injected dialog. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pendingKeys, trustPendingKeys } from '../src/keyTrust';
import { createKeyStore } from '../../server/src/plm/keyStore';
import { createSignaturePort } from '../../server/src/plm/signaturePort';
import { createTrustStore } from '../../server/src/plm/trustStore';

let dir = '';
let env: NodeJS.ProcessEnv = {};
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-trust-'));
  env = { ...process.env, VITEST: '1', LLULL_KEYS_DIR: path.join(dir, 'keys'), LLULL_TRUST_DIR: path.join(dir, 'trust') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('trusting keys in the desktop app', () => {
  it('an enrolled key is trusted by nothing until the user confirms it in a dialog that shows its owner and fingerprint', async () => {
    const key = await createKeyStore(env).create({
      userId: 'u-1',
      name: 'J. Example',
      passphrase: 'a long passphrase',
      at: '2026-11-02T09:00:00Z',
    });
    const port = createSignaturePort(createTrustStore(env), env);
    expect(port.keyTrust?.(key.publicKey)).toBe('untrusted');
    expect(pendingKeys(env).map((pending) => pending.keyId)).toEqual([key.keyId]);

    const shown: string[] = [];
    expect(await trustPendingKeys({ env, confirm: async (text) => (shown.push(text), false) })).toEqual([]);
    expect(port.keyTrust?.(key.publicKey)).toBe('untrusted');
    expect(shown[0]).toContain('J. Example');
    expect(shown[0]).toContain(key.publicKey.slice(0, 8));

    expect(await trustPendingKeys({ env, confirm: async () => true, now: () => new Date('2026-11-02T10:00:00Z') })).toEqual([key.keyId]);
    expect(port.keyTrust?.(key.publicKey)).toBe('trusted');
    expect(port.signerOf?.(key.publicKey)).toMatchObject({ userId: 'u-1', name: 'J. Example' });
    expect(pendingKeys(env)).toEqual([]);
  });

  it('a revoked key is never offered, and the trust file cannot be edited without the secret', async () => {
    const store = createKeyStore(env);
    const key = await store.create({ userId: 'u-1', name: 'J', passphrase: 'a long passphrase', at: '2026-11-02T09:00:00Z' });
    await trustPendingKeys({ env, confirm: async () => true });
    const trust = createTrustStore(env);
    expect(trust.revoke(key.publicKey, '2026-11-03T00:00:00Z')).toBe(true);
    expect(createSignaturePort(trust, env).keyTrust?.(key.publicKey)).toBe('untrusted');
    store.revoke(key.keyId, '2026-11-03T00:00:00Z');
    expect(pendingKeys(env)).toEqual([]);
  });
});
