import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { APPROVALS, T, fakePort, inReview, released, releasedB, reviewWithEco } from './fixtures';
import { agentContext, humanContext, run } from './scenarioRunner';

const SIGNER = { userId: 'u-1', name: 'J. Example' };
const KEY = 'ab'.repeat(32);
const SIGNATURE = 'cd'.repeat(64);

const sign = (doc: CadDocument, params: Record<string, unknown>, port = fakePort(true), caller: 'human' | 'agent' = 'human') =>
  run(
    doc,
    'record_signature',
    { alg: 'Ed25519', keyId: 'k-1', publicKey: KEY, signature: SIGNATURE, meaning: 'approval', signer: SIGNER, at: T, ...params },
    caller === 'human' ? humanContext({ humanSignature: port }) : agentContext({ humanSignature: port }),
  );

describe('record_signature (VC-PLM-17, 26)', () => {
  it('records a verified approval over the iteration manifest and satisfies the release signature policy', () => {
    const doc = reviewWithEco();
    const iteration = run(doc, 'release_manifest', { revision: 'A', kind: 'iteration' }).data as { sha256: string };
    const signed = sign(doc, { target: { kind: 'iteration', ref: 'A.1' } });
    expect(signed.rejected, signed.summary).toBeUndefined();
    const record = signed.document.plm?.item.revisions['A']?.signatures[0];
    expect(record).toMatchObject({
      alg: 'Ed25519',
      keyId: 'k-1',
      meaning: 'approval',
      target: { kind: 'iteration', ref: 'A.1' },
      signedSha256: iteration.sha256,
    });
    const strict = {
      ...signed.document,
      plm: { ...signed.document.plm, policy: { ...signed.document.plm?.policy, humanSignatureRequired: true } },
    } as CadDocument;
    const releasedDoc = run(strict, 'release_item', { changeOrder: 'ECO-0100', approvals: APPROVALS, at: T, by: 'u-1' });
    expect(releasedDoc.rejected, releasedDoc.summary).toBeUndefined();
    expect(run(strict, 'plm_status', {}).data).toMatchObject({ policy: { humanSignatureRequired: { value: true } } });
  });

  it('signs a released revision and verify_release re-verifies it through the port', () => {
    const doc = released();
    const signed = sign(doc, { target: { kind: 'release', ref: 'A' }, meaning: 'release' }).document;
    expect(signed.plm?.item.revisions['A']?.signatures).toHaveLength(1);
    const ok = run(signed, 'verify_release', { revision: 'A' }, humanContext({ humanSignature: fakePort(true) })).data as {
      signaturesValid: unknown;
    };
    expect(ok.signaturesValid).toBe(true);
    const bad = run(signed, 'verify_release', { revision: 'A' }, humanContext({ humanSignature: fakePort(false) })).data as {
      signaturesValid: unknown;
    };
    expect(bad.signaturesValid).toBe(false);
    const noPort = run(signed, 'verify_release', { revision: 'A' }, humanContext({ humanSignature: null })).data as {
      signaturesValid: unknown;
    };
    expect(noPort.signaturesValid).toBe('unverified (no verifier port)');
  });

  it('refuses a bad signature, an untrusted or test key, malformed hex and a missing port', () => {
    const doc = released();
    const target = { target: { kind: 'release', ref: 'A' } };
    expect(sign(doc, target, fakePort(false)).error?.code).toBe('PLM_SIGNATURE_INVALID');
    expect(sign(doc, { ...target, signature: 'zz' }).error?.code).toBe('PLM_SIGNATURE_INVALID');
    expect(sign(doc, target, fakePort(true, 'untrusted')).error?.code).toBe('PLM_KEY_UNTRUSTED');
    expect(sign(doc, target, fakePort(true, 'test')).error?.code).toBe('PLM_KEY_UNTRUSTED');
    const noPort = run(doc, 'record_signature', {
      ...target,
      alg: 'Ed25519',
      keyId: 'k',
      publicKey: KEY,
      signature: SIGNATURE,
      meaning: 'review',
      signer: SIGNER,
      at: T,
    });
    expect(noPort.error?.code).toBe('PLM_SIGNATURE_PORT_MISSING');
    expect(sign(doc, target, { verify: () => null }).error?.code).toBe('PLM_SIGNATURE_PORT_MISSING');
    expect(sign(doc, { target: { kind: 'release', ref: 'Z' } }).error?.code).toBe('PLM_REVISION_UNKNOWN');
    expect(sign(inReview(), target).error?.code).toBe('PLM_NOT_RELEASED');
    expect(sign(doc, { target: { kind: 'iteration', ref: 'A.9' } }).error?.code).toBe('PLM_REVISION_UNKNOWN');
    expect(sign(doc, target, fakePort(false)).document).toBe(doc);
  });

  it('approval and release signatures are human acts; a review signature is not', () => {
    const doc = released();
    expect(sign(doc, { target: { kind: 'release', ref: 'A' } }, fakePort(true), 'agent').error?.code).toBe('PLM_HUMAN_GATE');
    expect(sign(doc, { target: { kind: 'release', ref: 'A' }, meaning: 'review' }, fakePort(true), 'agent').rejected).toBeUndefined();
  });
});

describe('attach_release_package', () => {
  it('records the package hash of a released revision when the content hash agrees', () => {
    const doc = releasedB();
    const hash = doc.plm?.item.revisions['A']?.contentHash ?? '';
    const attached = run(doc, 'attach_release_package', {
      revision: 'A',
      manifestSha256: 'a'.repeat(64),
      documentContentHash: hash,
      location: '/vault/LL-2001_A',
    });
    expect(attached.document.plm?.item.revisions['A']?.packageSha256).toBe('a'.repeat(64));
    expect(attached.summary).toContain('/vault/LL-2001_A');
    expect(
      run(doc, 'attach_release_package', { revision: 'A', manifestSha256: 'a'.repeat(64), documentContentHash: 'f'.repeat(64) }).error
        ?.code,
    ).toBe('PLM_INTEGRITY_MISMATCH');
    expect(
      run(doc, 'attach_release_package', { revision: 'Z', manifestSha256: 'a'.repeat(64), documentContentHash: hash }).error?.code,
    ).toBe('PLM_REVISION_UNKNOWN');
    expect(
      run(inReview(), 'attach_release_package', { revision: 'A', manifestSha256: 'a'.repeat(64), documentContentHash: hash }).error?.code,
    ).toBe('PLM_NOT_RELEASED');
    expect(
      run(doc, 'attach_release_package', { revision: 'A', manifestSha256: 'a'.repeat(64), documentContentHash: hash }, agentContext()).error
        ?.code,
    ).toBe('PLM_HUMAN_GATE');
    expect(run(doc, 'attach_release_package', { revision: 'A', manifestSha256: 'short', documentContentHash: hash }).rejected).toBe(true);
  });
});
