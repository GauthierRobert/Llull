/** /signing endpoints (typed requests, rate limit) and POST /command (no caller label) - 09 PLM TR-PLM-16, TR-PLM-08. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc, setLiveDoc } from '../src/liveDocument';
import { verifyEd25519 } from '../src/plm/ed25519';
import { GATE_CONTEXT, createSignaturePort } from '../src/plm/signaturePort';
import { createTrustStore } from '../src/plm/trustStore';
import { actPayload } from '@plm/gate';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { pmiReviewPayload } from '@core/commands/pmi/review';
import { clearFailures, lockedForMs, recordFailure } from '../src/plm/signingLock';
import { PASSPHRASE, type TestHome, testHome, trustedKey } from './plmTestSupport';
import { reviewWithEco } from '../../tests/unit/plm/fixtures';

let home: TestHome;
beforeEach(() => {
  home = testHome();
  home.apply();
  _resetLiveDoc();
  _resetHistory();
});
afterEach(() => home.cleanup());

describe('/signing', () => {
  it('lists keys with their trust and signs only typed requests built by the server', async () => {
    const key = await trustedKey(home, 'u-1');
    const listed = await request(app).get('/signing/keys');
    expect(listed.body.keys).toEqual([{ ...key.record, trusted: true }]);

    const payload = 'a'.repeat(64);
    const gate = await request(app)
      .post('/signing/sign')
      .send({ kind: 'payload', act: 'dispose_margin', keyId: key.record.keyId, passphrase: PASSPHRASE, payloadSha256: payload });
    expect(gate.body.signature).toMatchObject({ alg: 'Ed25519', keyId: key.record.keyId, publicKey: key.record.publicKey });
    expect(verifyEd25519(key.record.publicKey, `${GATE_CONTEXT}${payload}`, gate.body.signature.signature)).toBe(true);
    expect(verifyEd25519(key.record.publicKey, payload, gate.body.signature.signature)).toBe(false);

    setLiveDoc(reviewWithEco());
    const live = getLiveDoc();
    const act = await request(app)
      .post('/signing/sign')
      .send({
        kind: 'gate',
        keyId: key.record.keyId,
        passphrase: PASSPHRASE,
        command: 'release_item',
        params: { changeOrder: 'ECO-0100' },
        nonce: 'nonce-route-1',
      });
    expect(act.body.payloadSha256).toBe(actPayload(live, 'release_item', { changeOrder: 'ECO-0100' }, 'nonce-route-1'));
    expect(act.body.signature.nonce).toBe('nonce-route-1');
    const port = createSignaturePort(createTrustStore(home.trust));
    expect(port.verify(act.body.signature, act.body.payloadSha256)?.signer).toBe('u-1');

    const manifestDoc = (await import('../../tests/unit/plm/fixtures')).released();
    setLiveDoc(manifestDoc);
    const manifest = await request(app)
      .post('/signing/sign')
      .send({ kind: 'manifest', keyId: key.record.keyId, passphrase: PASSPHRASE, revision: 'A', meaning: 'release' });
    expect(manifest.status).toBe(200);
    expect(manifest.body.signer).toEqual({ userId: 'u-1', name: 'J. Example' });

    for (const bad of [
      { kind: 'gate', command: 'add_box', params: {}, nonce: 'nonce-route-1' },
      { kind: 'manifest', revision: 'Z' },
      { kind: 'payload', payloadSha256: 'short' },
      { kind: 'payload', act: 'dispose_margin', payloadSha256: 'short' },
      { kind: 'payload', payloadSha256: 'a'.repeat(64) },
      { kind: 'payload', act: 'release_item', payloadSha256: 'a'.repeat(64) },
      { kind: 'pmi_review', pmiIds: ['nope'], decision: 'accept', comment: '', nonce: 'n-12345678' },
      { kind: 'other' },
      {},
    ])
      expect(
        (
          await request(app)
            .post('/signing/sign')
            .send({ keyId: key.record.keyId, passphrase: PASSPHRASE, ...bad })
        ).status,
      ).toBe(400);
    expect(
      (await request(app).post('/signing/sign').send({ kind: 'payload', keyId: 'k-none', passphrase: PASSPHRASE, payloadSha256: payload }))
        .status,
    ).toBe(400);
    expect((await request(app).post('/signing/sign').send({ keyId: 5 })).status).toBe(400);
  });

  it('a PMI review signature is computed by the server from the live document and binds the reviewed items', async () => {
    const key = await trustedKey(home, 'u-1');
    const datum = execute(createEmptyDocument(), 'add_pmi_note', { text: 'BREAK ALL SHARP EDGES' });
    setLiveDoc(datum.document);
    const id = datum.affected[0] as string;
    const review = { pmiIds: [id], decision: 'accept', comment: 'ok' };
    const signed = await request(app)
      .post('/signing/sign')
      .send({ kind: 'pmi_review', keyId: key.record.keyId, passphrase: PASSPHRASE, nonce: 'n-12345678', ...review });
    expect(signed.status).toBe(200);
    const payload = pmiReviewPayload(datum.document, [id], 'accept', 'ok', 'n-12345678');
    expect(signed.body.payloadSha256).toBe(payload);
    expect(verifyEd25519(key.record.publicKey, `${GATE_CONTEXT}${payload}`, signed.body.signature.signature)).toBe(true);
  });

  it('five wrong passphrases lock the key for a minute (429), and a wrong one never signs', async () => {
    const key = await trustedKey(home, 'u-1');
    const wrong = (): request.Test =>
      request(app)
        .post('/signing/sign')
        .send({
          kind: 'payload',
          act: 'dispose_margin',
          keyId: key.record.keyId,
          passphrase: 'wrong passphrase!',
          payloadSha256: 'b'.repeat(64),
        });
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await wrong()).status).toBe(403);
    expect((await wrong()).status).toBe(429);
    const right = await request(app)
      .post('/signing/sign')
      .send({ kind: 'payload', act: 'dispose_margin', keyId: key.record.keyId, passphrase: PASSPHRASE, payloadSha256: 'b'.repeat(64) });
    expect(right.status).toBe(429);
    // the lock is persisted: it survives the process (a fresh router reads it back) and doubles with every further failure
    expect(lockedForMs(key.record.keyId, Date.now())).toBeGreaterThan(0);
    expect(recordFailure(key.record.keyId, Date.now())).toBe(120_000);
    clearFailures(key.record.keyId);
    expect(lockedForMs(key.record.keyId, Date.now())).toBe(0);
  });
});

describe('POST /command', () => {
  const identity = { partNumber: 'LL-9', name: 'n', itemType: 'part' };

  it('there is no way to claim to be human: a caller field, a client field or a policy change without a signature is refused', async () => {
    const withPolicy = { ...identity, policy: { humanSignatureRequired: false } };
    for (const extra of [{}, { caller: 'human' }, { client: 'ui' }, { client: 'cli', caller: 'human' }]) {
      const refused = await request(app)
        .post('/command')
        .send({ name: 'set_item_identity', params: withPolicy, ...extra });
      expect(refused.body.error.code, JSON.stringify(extra)).toBe('PLM_HUMAN_GATE');
    }
    expect(getLiveDoc().plm).toBeUndefined();
    const created = await request(app).post('/command').send({ name: 'set_item_identity', params: identity });
    expect(created.body.isError).toBe(false);
    const submit = await request(app).post('/command').send({ name: 'submit_for_review', params: {} });
    expect(submit.body.isError).toBe(false);
    expect(getLiveDoc().plm?.item.revisions['A']?.stateHistory.at(-1)?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const approval = await request(app)
      .post('/command')
      .send({ name: 'record_approval', params: { role: 'checker', userId: 'u-2' }, caller: 'human' });
    expect(approval.body.error.code).toBe('PLM_HUMAN_GATE');
  });
});
