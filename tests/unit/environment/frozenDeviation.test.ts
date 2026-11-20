/**
 * A saved document with a human deviation signed before the MOI-b gate refactor (tests/corpus/documents/v3-environment-deviation.llull.json):
 * the stored signature must keep verifying after any change to the gate. The port accepts exactly the frozen signature over the frozen payload
 * (sha256 of act, item key, decision, justification, fingerprint, document uid, nonce), so a change of any payload field shows up here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import { createEmptyDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

const FIXTURE = path.resolve(__dirname, '../../corpus/documents/v3-environment-deviation.llull.json');
const KEY = 'outgassing:syn_water|TML';
/** The payload the deviation was signed over, frozen when the fixture was written. */
const FROZEN_PAYLOAD = '6751da7a623e49aa26a9c74c28e8865fc1be2bfec3a46dfe71cc679d5e173407';
const FROZEN_UID = '96600ecd9cebe657afc5caf87981f09b';

const frozenPort: HumanSignaturePort = {
  verify: (signature, payload) =>
    isRecord(signature) && signature['key'] === 'frozen-test-key' && signature['nonce'] === 'frozen-nonce-1' && payload === FROZEN_PAYLOAD
      ? { signer: 'frozen-reviewer', signatureId: 'frozen-sig-1' }
      : null,
};

interface Item {
  key: string;
  status: string;
  deviation?: { decision: string; signer: string };
  unconfirmedDeviation?: string;
  staleDeviation?: true;
}

function loaded(): ReturnType<typeof createEmptyDocument> {
  const result = execute(createEmptyDocument(), 'load_document', { json: readFileSync(FIXTURE, 'utf8') });
  expect(result.error).toBeUndefined();
  return result.document;
}

const check = (port: HumanSignaturePort | null): { status: string; items: Item[] } =>
  execute(loaded(), 'check_space_environment', { profile: 'nasa_gsfc_screening' }, { ...defaultContext(), humanSignature: port }).data as {
    status: string;
    items: Item[];
  };

describe('frozen environment deviation (stored signature survives gate refactors)', () => {
  it('loads with its uid and the deviation re-verifies as ok: the failing TML item is covered', () => {
    expect(loaded().uid).toBe(FROZEN_UID);
    const data = check(frozenPort);
    const item = data.items.find((entry) => entry.key === KEY);
    expect(item).toMatchObject({ status: 'fail', deviation: { decision: 'accepted', signer: 'frozen-reviewer' } });
    expect(item?.unconfirmedDeviation).toBeUndefined();
    expect(item?.staleDeviation).toBeUndefined();
    expect(data.status).toBe('pass');
  });

  it('a port that rejects it, or none, keeps the item in the status', () => {
    const rejected = check({ verify: () => null });
    expect(rejected.items.find((entry) => entry.key === KEY)?.unconfirmedDeviation).toBe('invalid');
    expect(rejected.status).toBe('fail');
    expect(check(null).items.find((entry) => entry.key === KEY)?.unconfirmedDeviation).toBe('noport');
  });
});
