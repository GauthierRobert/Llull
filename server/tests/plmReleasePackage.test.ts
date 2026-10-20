/** Signed release package (09 PLM VC-PLM-18, FR-PLM-21): write, verify with llull and with plain node:crypto, flip one byte. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CadDocument } from '@core/model/types';
import { createKeyStore } from '../src/plm/keyStore';
import { createSignaturePort } from '../src/plm/signaturePort';
import { buildReleasePackage, signedBodyOf, verifyReleasePackage, writeReleasePackage } from '../src/plm/releasePackage';
import { APPROVALS, T, reviewWithEco } from '../../tests/unit/plm/fixtures';

let dir = '';
let env: NodeJS.ProcessEnv = {};
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-pkg-'));
  env = { ...process.env, LLULL_KEYS_DIR: path.join(dir, 'keys') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A released, release-signed revision A of the sample part with one sheet (signed with a real local key). */
function signedRelease(): { doc: CadDocument; store: ReturnType<typeof createKeyStore>; keyId: string } {
  const store = createKeyStore(env);
  const key = store.create({ userId: 'u-1', name: 'J. Example', passphrase: 'p', at: T });
  const human = { ...defaultContext(), caller: { kind: 'human' as const }, humanSignature: createSignaturePort(store, env) };
  const withSheet = execute(reviewWithEco(), 'reject_review', { comment: 'add the drawing', at: T, by: 'u-1' }, human).document;
  const drawn = execute(withSheet, 'create_sheet', { name: 'S1', views: ['front'] }, human).document;
  const review = execute(drawn, 'submit_for_review', { at: T, by: 'u-1' }, human).document;
  const released = execute(review, 'release_item', { changeOrder: 'ECO-0100', approvals: APPROVALS, at: T, by: 'u-1' }, human).document;
  const manifest = execute(released, 'release_manifest', { revision: 'A' }, human).data as { canonical: string };
  const signed = execute(
    released,
    'record_signature',
    {
      target: { kind: 'release', ref: 'A' },
      alg: 'Ed25519',
      keyId: key.keyId,
      publicKey: key.publicKey,
      signature: store.sign(key.keyId, 'p', manifest.canonical),
      meaning: 'release',
      signer: { userId: 'u-1', name: 'J. Example' },
      at: T,
    },
    human,
  );
  expect(signed.rejected, signed.summary).toBeUndefined();
  return { doc: signed.document, store, keyId: key.keyId };
}

const port = (): ReturnType<typeof createSignaturePort> => createSignaturePort(createKeyStore(env), env);

describe('release package', () => {
  it('writes a read-only package that verifies, and a flipped byte anywhere is found', () => {
    const { doc } = signedRelease();
    const pack = buildReleasePackage(doc, 'A', '0.1.0');
    expect(typeof pack).not.toBe('string');
    if (typeof pack === 'string') return;
    const out = path.join(dir, 'LL-2001_A');
    const written = writeReleasePackage(pack, out);
    expect(written.files).toBe(pack.files.length + 1);
    expect(existsSync(path.join(out, 'model/LL-2001_A.llull.json'))).toBe(true);
    expect(pack.files.some((file) => file.path.startsWith('drawings/'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path.join(out, 'manifest.json')).mode & 0o222).toBe(0);
    const ok = verifyReleasePackage(out, port());
    expect(ok).toMatchObject({ ok: true, findings: [] });
    expect(() => writeReleasePackage(pack, out)).toThrow('immutable');

    const model = path.join(out, 'model/LL-2001_A.llull.json');
    chmodSync(model, 0o644);
    const original = readFileSync(model);
    const flipped = Buffer.from(original);
    flipped[10] = (flipped[10] ?? 0) ^ 0xff;
    writeFileSync(model, flipped);
    expect(verifyReleasePackage(out, port()).findings.map((finding) => finding.code)).toContain('PLM_PACKAGE_MEMBER_MISMATCH');
    writeFileSync(model, original);
    expect(verifyReleasePackage(out, port()).ok).toBe(true);

    const manifestFile = path.join(out, 'manifest.json');
    chmodSync(manifestFile, 0o644);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { item: { revision: string } };
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, item: { ...manifest.item, revision: 'B' } }));
    const tampered = verifyReleasePackage(out, port()).findings.map((finding) => finding.code);
    expect(tampered).toEqual(expect.arrayContaining(['PLM_PACKAGE_MANIFEST_MISMATCH', 'PLM_SIGNATURE_INVALID']));
    writeFileSync(manifestFile, '{ not json');
    expect(verifyReleasePackage(out, port()).findings[0]?.code).toBe('PLM_PACKAGE_UNREADABLE');
    expect(verifyReleasePackage(path.join(dir, 'nowhere'), port()).ok).toBe(false);
  });

  it('verifies with nothing but sha256sum and an RFC 8032 verifier (no llull code)', () => {
    const { doc } = signedRelease();
    const pack = buildReleasePackage(doc, 'A', '0.1.0');
    if (typeof pack === 'string') throw new Error(pack);
    const out = path.join(dir, 'independent');
    writeReleasePackage(pack, out);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as Record<string, unknown> & {
      members: { path: string; sha256: string }[];
      signatures: { publicKey: string; signature: string }[];
    };
    for (const member of manifest.members)
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(out, member.path)))
          .digest('hex'),
      ).toBe(member.sha256);
    const canonical = (value: unknown): string =>
      Array.isArray(value)
        ? `[${value.map(canonical).join(',')}]`
        : value !== null && typeof value === 'object'
          ? `{${Object.keys(value as object)
              .sort()
              .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
              .join(',')}}`
          : JSON.stringify(value);
    const body = canonical(signedBodyOf(manifest));
    const [signature] = manifest.signatures;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signature?.publicKey ?? '', 'hex')]),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, Buffer.from(body, 'utf8'), key, Buffer.from(signature?.signature ?? '', 'hex'))).toBe(true);
    expect(manifest['documentContentHash']).toBe(manifest.members[0]?.sha256);
    expect(manifest['documentContentHash']).toBe(doc.plm?.item.revisions['A']?.contentHash);
    expect(manifest).toMatchObject({
      tool: { name: 'llull', version: '0.1.0' },
      lifecycleState: 'released',
      item: { revision: 'A', partNumber: 'LL-2001' },
    });
  });

  it('reports a revoked signer key and a verifier-less host', () => {
    const { doc, store, keyId } = signedRelease();
    const pack = buildReleasePackage(doc, 'A', 'dev');
    if (typeof pack === 'string') throw new Error(pack);
    const out = path.join(dir, 'p');
    writeReleasePackage(pack, out);
    expect(verifyReleasePackage(out, null).findings.map((finding) => finding.code)).toEqual(['PLM_SIGNATURE_UNVERIFIED']);
    store.revoke(keyId, T);
    expect(verifyReleasePackage(out, port()).findings.map((finding) => finding.code)).toEqual(['PLM_KEY_UNTRUSTED']);
  });

  it('refuses a revision that is not frozen', () => {
    expect(buildReleasePackage(reviewWithEco(), 'A', 'dev')).toContain('not a frozen');
    expect(buildReleasePackage(signedRelease().doc, 'Z', 'dev')).toContain('not a frozen');
  });
});
