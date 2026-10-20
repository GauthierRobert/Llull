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
let deps: { keysEnv: NodeJS.ProcessEnv; trustDir: string } = { keysEnv: {}, trustDir: '' };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-trust-'));
  deps = { keysEnv: { ...process.env, LLULL_KEYS_DIR: path.join(dir, 'keys') }, trustDir: path.join(dir, 'trust') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enroll = (userId: string, name = 'J. Example'): ReturnType<ReturnType<typeof createKeyStore>['create']> =>
  createKeyStore(deps.keysEnv).create({ userId, name, passphrase: 'a long passphrase', at: '2026-11-02T09:00:00Z' });

describe('trusting keys in the desktop app', () => {
  it('an enrolled key is trusted by nothing until the user confirms it in a dialog that shows its owner, creation time and fingerprint', async () => {
    const key = await enroll('u-1');
    const port = createSignaturePort(createTrustStore(deps.trustDir));
    expect(port.keyTrust?.(key.publicKey)).toBe('untrusted');
    expect(pendingKeys(deps).map((pending) => pending.keyId)).toEqual([key.keyId]);

    const shown: string[] = [];
    expect(await trustPendingKeys({ ...deps, confirm: async (text) => (shown.push(text), false) })).toEqual([]);
    expect(port.keyTrust?.(key.publicKey)).toBe('untrusted');
    expect(shown[0]).toContain('J. Example');
    expect(shown[0]).toContain('2026-11-02T09:00:00Z');
    expect(shown[0]).toContain(key.publicKey.slice(0, 8));
    expect(shown[0]).not.toContain('WARNING');

    expect(await trustPendingKeys({ ...deps, confirm: async () => true, now: () => new Date('2026-11-02T10:00:00Z') })).toEqual([
      key.keyId,
    ]);
    expect(port.keyTrust?.(key.publicKey)).toBe('trusted');
    expect(port.signerOf?.(key.publicKey)).toMatchObject({ userId: 'u-1', name: 'J. Example' });
    expect(pendingKeys(deps)).toEqual([]);
  });

  it('warns when the owner already has a trusted key or several keys are waiting', async () => {
    await enroll('u-1');
    await trustPendingKeys({ ...deps, confirm: async () => true });
    await enroll('u-1', 'Look-alike');
    await enroll('u-2');
    const shown: string[] = [];
    await trustPendingKeys({ ...deps, confirm: async (text) => (shown.push(text), false) });
    expect(shown[0]).toContain('already has 1 trusted key');
    expect(shown[0]).toContain('2 keys are waiting');
  });

  it('a revoked key is never offered, and the trust file cannot be edited without the secret', async () => {
    const key = await enroll('u-1', 'J');
    await trustPendingKeys({ ...deps, confirm: async () => true });
    const trust = createTrustStore(deps.trustDir);
    expect(trust.revoke(key.publicKey, '2026-11-03T00:00:00Z')).toBe(true);
    expect(createSignaturePort(trust).keyTrust?.(key.publicKey)).toBe('untrusted');
    createKeyStore(deps.keysEnv).revoke(key.keyId, '2026-11-03T00:00:00Z');
    expect(pendingKeys(deps)).toEqual([]);
  });
});
