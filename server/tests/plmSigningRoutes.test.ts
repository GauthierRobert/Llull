/** /signing endpoints and the human caller over POST /command (09 PLM TR-PLM-16, TR-PLM-08). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { createKeyStore } from '../src/plm/keyStore';
import { verifyEd25519 } from '../src/plm/ed25519';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-sign-'));
  process.env['LLULL_KEYS_DIR'] = dir;
  _resetLiveDoc();
  _resetHistory();
});
afterEach(() => {
  delete process.env['LLULL_KEYS_DIR'];
  rmSync(dir, { recursive: true, force: true });
});

describe('/signing', () => {
  it('lists keys and signs with the right passphrase only', async () => {
    const record = createKeyStore().create({ userId: 'u-1', name: 'J. Example', passphrase: 'pw', at: '2026-11-02T09:00:00Z' });
    const listed = await request(app).get('/signing/keys');
    expect(listed.body.keys).toEqual([record]);
    const raw = await request(app).post('/signing/sign').send({ keyId: record.keyId, passphrase: 'pw', message: 'manifest bytes' });
    expect(raw.status).toBe(200);
    expect(verifyEd25519(record.publicKey, 'manifest bytes', raw.body.signature)).toBe(true);
    expect(raw.body.signer).toEqual({ userId: 'u-1', name: 'J. Example' });
    const gate = await request(app)
      .post('/signing/sign')
      .send({ keyId: record.keyId, passphrase: 'pw', payloadSha256: 'a'.repeat(64) });
    expect(gate.body.signature).toMatchObject({ alg: 'Ed25519', keyId: record.keyId, publicKey: record.publicKey });
    expect(verifyEd25519(record.publicKey, 'a'.repeat(64), gate.body.signature.signature)).toBe(true);
    expect((await request(app).post('/signing/sign').send({ keyId: record.keyId, passphrase: 'nope', message: 'x' })).status).toBe(403);
    expect((await request(app).post('/signing/sign').send({ keyId: 'k-none', passphrase: 'pw', message: 'x' })).status).toBe(400);
    expect((await request(app).post('/signing/sign').send({ keyId: record.keyId, passphrase: 'pw' })).status).toBe(400);
    expect((await request(app).post('/signing/sign').send({ keyId: 5 })).status).toBe(400);
  });
});

describe('POST /command caller', () => {
  const identity = { partNumber: 'LL-9', name: 'n', itemType: 'part', policy: { humanSignatureRequired: false } };

  it('a request is an agent unless it says caller human; the filled time is what live sync replays', async () => {
    const agent = await request(app).post('/command').send({ name: 'set_item_identity', params: identity });
    expect(agent.body.isError).toBe(true);
    expect(agent.body.error.code).toBe('PLM_HUMAN_GATE');
    const human = await request(app).post('/command').send({ name: 'set_item_identity', params: identity, caller: 'human' });
    expect(human.body.isError).toBe(false);
    const submit = await request(app).post('/command').send({ name: 'submit_for_review', params: {}, caller: 'agent' });
    expect(submit.body.isError).toBe(false);
    expect(getLiveDoc().plm?.item.revisions['A']?.stateHistory.at(-1)?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const approval = await request(app)
      .post('/command')
      .send({ name: 'record_approval', params: { role: 'checker', userId: 'u-2' }, caller: 'agent' });
    expect(approval.body.error.code).toBe('PLM_HUMAN_GATE');
  });
});
