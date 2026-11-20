/**
 * A saved document with a reviewer disposition of an acoustic load package (tests/corpus/documents/v3-acoustic-review.llull.json, VAC-M3): the stored
 * signature must keep verifying after any change to the gate or to the fingerprint. The port accepts exactly the frozen signature over the frozen payload
 * (sha256 of act, exposure, decision, justification, fingerprint, document uid, nonce), so a change of any payload field, or of what the fingerprint
 * covers, shows up here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import { createEmptyDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { boxKernel } from './boxKernel';

const FIXTURE = path.resolve(__dirname, '../../corpus/documents/v3-acoustic-review.llull.json');
/** The payload the disposition was signed over, frozen when the fixture was written. */
const FROZEN_PAYLOAD = 'd2f1b6d08c0832873f54914c3d5e516e0d64d176c3a6479f54f1ee56333bb43b';
const FROZEN_FINGERPRINT = 'b6a394382552ebf43c43129dec1ae2680c3f2d43910ae01958a60203f002793c';
const FROZEN_UID = '96600ecd9cebe657afc5caf87981f09b';

const frozenPort: HumanSignaturePort = {
  verify: (signature, payload) =>
    isRecord(signature) && signature['key'] === 'frozen-test-key' && signature['nonce'] === 'frozen-nonce-1' && payload === FROZEN_PAYLOAD
      ? { signer: 'frozen-reviewer', signatureId: 'frozen-sig-1' }
      : null,
};

interface Package {
  review: { status: string; fingerprint: string; signer?: string; unconfirmed?: string };
  items: { code: string }[];
}

function loaded(): ReturnType<typeof createEmptyDocument> {
  const result = execute(createEmptyDocument(), 'load_document', { json: readFileSync(FIXTURE, 'utf8') });
  expect(result.error).toBeUndefined();
  return result.document;
}

const exported = (port: HumanSignaturePort | null): Package =>
  execute(
    loaded(),
    'export_acoustic_load',
    { exposure: 'enclosure_skin' },
    { ...defaultContext(), kernel: boxKernel(), humanSignature: port },
  ).data as Package;

describe('frozen acoustic review (stored signature survives gate refactors)', () => {
  it('loads with its uid; the disposition re-verifies: accepted, no VAC_REVIEW_PENDING, same fingerprint', () => {
    expect(loaded().uid).toBe(FROZEN_UID);
    const data = exported(frozenPort);
    expect(data.review).toMatchObject({ status: 'accepted', fingerprint: FROZEN_FINGERPRINT, signer: 'frozen-reviewer' });
    expect(data.items.map((item) => item.code)).toEqual([]);
  });

  it('a port that rejects it, or none, keeps VAC_REVIEW_PENDING', () => {
    expect(exported({ verify: () => null }).review).toMatchObject({ status: 'unconfirmed', unconfirmed: 'invalid' });
    const noPort = exported(null);
    expect(noPort.review.unconfirmed).toBe('noport');
    expect(noPort.items.map((item) => item.code)).toEqual(['VAC_REVIEW_PENDING']);
  });
});
