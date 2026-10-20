/** Signed release package (09 PLM VC-PLM-18, FR-PLM-21): write, verify with llull and with plain node:crypto, flip one byte, path traversal. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CadDocument } from '@core/model/types';
import { createSignaturePort } from '../src/plm/signaturePort';
import { createTrustStore } from '../src/plm/trustStore';
import { createKeyStore } from '../src/plm/keyStore';
import { buildReleasePackage, signedBodyOf, verifyReleasePackage, writeReleasePackage } from '../src/plm/releasePackage';
import { run } from '../../tests/unit/plm/scenarioRunner';
import { approveAll, inWork, reviewWithEco } from '../../tests/unit/plm/fixtures';
import { T, type TestHome, testHome, trustedKey } from './plmTestSupport';

let home: TestHome;
let dir = '';
beforeEach(() => {
  home = testHome();
  dir = home.dir;
});
afterEach(() => home.cleanup());

const port = (): ReturnType<typeof createSignaturePort> => createSignaturePort(createTrustStore(home.env), home.env);

/** A released revision A of the sample part with one sheet, release-signed with a real, trusted local key. */
async function signedRelease(): Promise<{ doc: CadDocument; keyRecord: { keyId: string; publicKey: string } }> {
  const key = await trustedKey(home.env, 'u-1');
  const withSheet = run(reviewWithEco(), 'reject_review', { comment: 'add the drawing', at: T, by: 'u-1' }).document;
  const drawn = run(withSheet, 'create_sheet', { name: 'S1', views: ['front'] }).document;
  const review = run(drawn, 'submit_for_review', { at: T, by: 'u-1' }).document;
  const released = run(approveAll(review), 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document;
  const real = { ...defaultContext(), humanSignature: port() };
  const manifest = execute(released, 'release_manifest', { revision: 'A', meaning: 'release' }, real).data as { canonical: string };
  const signed = execute(
    released,
    'record_signature',
    {
      target: { kind: 'release', ref: 'A' },
      alg: 'Ed25519',
      keyId: key.record.keyId,
      publicKey: key.record.publicKey,
      signature: await key.raw(manifest.canonical),
      meaning: 'release',
      signer: { userId: 'u-1', name: 'J. Example' },
      at: T,
    },
    real,
  );
  expect(signed.rejected, signed.summary).toBeUndefined();
  return { doc: signed.document, keyRecord: key.record };
}

describe('release package', () => {
  it('writes a read-only package that verifies, and a flipped byte anywhere is found', async () => {
    const { doc } = await signedRelease();
    const pack = buildReleasePackage(doc, 'A', '0.1.0');
    expect(typeof pack).not.toBe('string');
    if (typeof pack === 'string') return;
    const out = path.join(dir, 'LL-2001_A');
    const written = writeReleasePackage(pack, out);
    expect(written.files).toBe(pack.files.length + 1);
    expect(existsSync(path.join(out, 'model/LL-2001_A.llull.json'))).toBe(true);
    expect(pack.files.some((file) => file.path.startsWith('drawings/'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path.join(out, 'manifest.json')).mode & 0o222).toBe(0);
    expect(verifyReleasePackage(out, port())).toMatchObject({ ok: true, findings: [] });
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

  it('verifies with nothing but sha256sum and an RFC 8032 verifier (no llull code)', async () => {
    const { doc } = await signedRelease();
    const pack = buildReleasePackage(doc, 'A', '0.1.0');
    if (typeof pack === 'string') throw new Error(pack);
    const out = path.join(dir, 'independent');
    writeReleasePackage(pack, out);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as Record<string, unknown> & {
      members: { path: string; sha256: string }[];
      signatures: { publicKey: string; signature: string; meaning: string }[];
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
    const [signature] = manifest.signatures;
    const body = canonical(signedBodyOf(manifest, signature?.meaning ?? ''));
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

  it('reports a revoked signer key, a verifier-less host and a package without any signature', async () => {
    const { doc, keyRecord } = await signedRelease();
    const pack = buildReleasePackage(doc, 'A', 'dev');
    if (typeof pack === 'string') throw new Error(pack);
    const out = path.join(dir, 'p');
    writeReleasePackage(pack, out);
    expect(verifyReleasePackage(out, null).findings.map((finding) => finding.code)).toEqual(['PLM_SIGNATURE_UNVERIFIED']);
    createKeyStore(home.env).revoke(keyRecord.keyId, T);
    createTrustStore(home.env).revoke(keyRecord.publicKey, T);
    expect(verifyReleasePackage(out, port()).findings.map((finding) => finding.code)).toEqual(['PLM_KEY_UNTRUSTED']);
    const unsigned = run(approveAll(reviewWithEco()), 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document;
    const bare = buildReleasePackage(unsigned, 'A', 'dev');
    if (typeof bare === 'string') throw new Error(bare);
    writeReleasePackage(bare, path.join(dir, 'bare'));
    const verdict = verifyReleasePackage(path.join(dir, 'bare'), port());
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((finding) => finding.code)).toEqual(['PLM_SIGNATURE_MISSING']);
  });

  it('refuses a revision that is not frozen', async () => {
    expect(buildReleasePackage(reviewWithEco(), 'A', 'dev')).toContain('not a frozen');
    expect(buildReleasePackage((await signedRelease()).doc, 'Z', 'dev')).toContain('not a frozen');
  });
});

describe('path traversal', () => {
  it('a part number with separators and dots cannot place files outside the package folder', async () => {
    const identity = run(approveAll(inWork()), 'plm_status', {}).document;
    expect(identity.plm?.item.partNumber).toBe('LL-2001');
    const evil = run(identity, 'set_item_identity', { partNumber: 'LL/../../EVIL', name: 'n', itemType: 'part' });
    expect(evil.document.plm?.item.partNumber).toBe('LL/../../EVIL');
    const hacked = {
      ...evil.document,
      plm: {
        ...evil.document.plm,
        item: {
          ...evil.document.plm?.item,
          revisions: {
            A: {
              ...evil.document.plm?.item.revisions['A'],
              state: 'released',
              contentHash: 'h',
              snapshot: { kind: 'inline', canonicalJson: '{"document":{},"format":"llull-document","version":2}' },
            },
          },
        },
      },
    } as CadDocument;
    const pack = buildReleasePackage(hacked, 'A', 'dev');
    if (typeof pack === 'string') return;
    for (const file of pack.files) {
      expect(file.path).not.toContain('..');
      expect(file.path.split('/').every((part) => /^[A-Za-z0-9._-]+$/.test(part))).toBe(true);
    }
  });

  it('writing refuses a file that leaves the folder, and verifying refuses a member path that does', () => {
    const base = { manifest: { manifestSha256: 'x' }, notes: [] as string[] };
    expect(() => writeReleasePackage({ ...base, files: [{ path: '../escape.txt', content: 'x' }] }, path.join(dir, 'pkg'))).toThrow(
      'leaves the package folder',
    );
    expect(() =>
      writeReleasePackage({ ...base, files: [{ path: path.resolve(dir, 'abs.txt'), content: 'x' }] }, path.join(dir, 'pkg2')),
    ).toThrow('leaves the package folder');
    expect(existsSync(path.join(dir, 'escape.txt'))).toBe(false);
    const out = path.join(dir, 'crafted');
    writeReleasePackage({ ...base, files: [{ path: 'model/a.json', content: '{}' }] }, out);
    writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
    const manifestFile = path.join(out, 'manifest.json');
    chmodSync(manifestFile, 0o644);
    const sha = createHash('sha256').update('top secret').digest('hex');
    writeFileSync(
      manifestFile,
      JSON.stringify({
        members: [{ path: '../secret.txt', sha256: sha, bytes: 10, canonical: true }],
        documentContentHash: sha,
        signatures: [],
      }),
    );
    const verdict = verifyReleasePackage(out, port());
    expect(verdict.findings.map((finding) => finding.code)).toContain('PLM_PACKAGE_MEMBER_MISMATCH');
  });
});
