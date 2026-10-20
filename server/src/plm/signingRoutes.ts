/**
 * Local signing endpoints for the desktop app (09 PLM TR-PLM-08): the human types a key passphrase in the app, the backend signs with the key store of
 * this machine and returns the signature; nothing is stored and the passphrase is never logged or returned. Typed requests only, so the server (not the
 * caller) builds the bytes it signs wherever it can:
 *   GET  /signing/keys   enrolled public keys (userId, name, public key, revoked, trusted)
 *   POST /signing/sign   { kind: 'gate', keyId, passphrase, command, params, nonce }   a plm human act: the payload comes from `plm_act_payload` on the live document
 *                        { kind: 'manifest', keyId, passphrase, revision, manifestKind?, meaning? }   the canonical manifest bytes come from `release_manifest`
 *                        { kind: 'pmi_review', keyId, passphrase, pmiIds, decision, comment, nonce }   accept_pmi_review: the payload (with a hash of the
 *                        reviewed items) is computed here from the live document
 *                        { kind: 'payload', keyId, passphrase, act, payloadSha256 }   the dispose_* acts of other gaps, whose payload the client computed from the
 *                        row it shows (the server cannot recompute analysis rows): `act` must be one of DISPOSE_ACTS, and every such signature is written to
 *                        the audit chain; the signed bytes are context-prefixed (`llull-gate-v1:`), so they cannot be replayed as a manifest
 * Wrong passphrases are counted per key and persisted (signingLock): after four, each further one doubles the lock (429), surviving restarts.
 */

import { Router, type RequestHandler } from 'express';
import { execute } from '@core/commands/registry';
import { pmiReviewPayload } from '@core/commands/pmi/review';
import { isRecord } from '@lib/isRecord';
import { getLiveDoc } from '../liveDocument';
import { guardMutation, guardRead } from '../security';
import { appendSafely, paramsHash } from './auditChain';
import { auditLogOf } from './hostRun';
import { createKeyStore } from './keyStore';
import { clearFailures, lockedForMs, recordFailure } from './signingLock';
import { GATE_CONTEXT } from './signaturePort';
import { createTrustStore } from './trustStore';

/** The dispose acts a client-computed payload may be signed for (kind 'payload'). */
const DISPOSE_ACTS: ReadonlySet<string> = new Set([
  'dispose_margin',
  'dispose_thermal_limit',
  'dispose_fit_result',
  'set_review_disposition',
]);

export function buildSigningRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.get('/signing/keys', restLimiter, guardRead(), (_req, res) => {
    const trust = createTrustStore();
    res.status(200).json({
      keys: createKeyStore()
        .list()
        .map((key) => ({ ...key, trusted: trust.find(key.publicKey) !== null })),
    });
  });
  router.post('/signing/sign', restLimiter, guardMutation(), async (req, res) => {
    const body: unknown = req.body;
    if (!isRecord(body) || typeof body['keyId'] !== 'string' || typeof body['passphrase'] !== 'string')
      return void res
        .status(400)
        .json({ error: 'Body needs keyId and passphrase (strings) and a typed request (kind gate | manifest | payload).' });
    const store = createKeyStore();
    const key = store.find(body['keyId']);
    if (key === undefined) return void res.status(400).json({ error: 'Unknown key.' });
    const kind = body['kind'];
    let text: string | null = null;
    let reply: (signature: string) => unknown = () => null;
    if (kind === 'gate' && typeof body['command'] === 'string' && isRecord(body['params']) && typeof body['nonce'] === 'string') {
      const payload = execute(getLiveDoc(), 'plm_act_payload', { command: body['command'], params: body['params'], nonce: body['nonce'] });
      const hash = (payload.data as { payloadSha256?: string } | undefined)?.payloadSha256;
      if (hash === undefined) return void res.status(400).json({ error: payload.summary });
      text = `${GATE_CONTEXT}${hash}`;
      reply = (signature) => ({
        signature: { alg: 'Ed25519', keyId: key.keyId, publicKey: key.publicKey, signature, nonce: body['nonce'] },
        payloadSha256: hash,
      });
    } else if (kind === 'manifest' && typeof body['revision'] === 'string') {
      const manifest = execute(getLiveDoc(), 'release_manifest', {
        revision: body['revision'],
        ...(body['manifestKind'] === 'iteration' ? { kind: 'iteration' } : {}),
        ...(typeof body['meaning'] === 'string' ? { meaning: body['meaning'] } : {}),
      });
      const canonical = (manifest.data as { canonical?: string } | undefined)?.canonical;
      if (canonical === undefined) return void res.status(400).json({ error: manifest.summary });
      text = canonical;
      reply = (signature) => ({ signature, keyId: key.keyId, publicKey: key.publicKey, signer: { userId: key.userId, name: key.name } });
    } else if (
      kind === 'pmi_review' &&
      Array.isArray(body['pmiIds']) &&
      body['pmiIds'].every((id) => typeof id === 'string') &&
      (body['decision'] === 'accept' || body['decision'] === 'reject') &&
      typeof body['comment'] === 'string' &&
      typeof body['nonce'] === 'string'
    ) {
      const doc = getLiveDoc();
      const ids = body['pmiIds'] as string[];
      if (ids.length === 0 || ids.some((id) => doc.pmi?.items[id] === undefined))
        return void res.status(400).json({ error: 'Unknown PMI item.' });
      const hash = pmiReviewPayload(doc, ids, body['decision'], body['comment'], body['nonce']);
      text = `${GATE_CONTEXT}${hash}`;
      reply = (signature) => ({
        signature: { alg: 'Ed25519', keyId: key.keyId, publicKey: key.publicKey, signature, nonce: body['nonce'] },
        payloadSha256: hash,
      });
    } else if (
      kind === 'payload' &&
      typeof body['act'] === 'string' &&
      DISPOSE_ACTS.has(body['act']) &&
      typeof body['payloadSha256'] === 'string' &&
      /^[0-9a-f]{64}$/.test(body['payloadSha256'])
    ) {
      text = `${GATE_CONTEXT}${body['payloadSha256']}`;
      const log = auditLogOf();
      if (log !== null)
        appendSafely(log, {
          ts: new Date().toISOString(),
          source: 'signing',
          command: `sign:${body['act']}`,
          paramsSha256: paramsHash({ keyId: key.keyId, payloadSha256: body['payloadSha256'] }),
          summary: `key ${key.keyId} of ${key.userId} asked to sign ${body['act']} payload ${body['payloadSha256']}`,
          changed: false,
          rejected: false,
          affectedCount: 0,
        });
      reply = (signature) => ({ signature: { alg: 'Ed25519', keyId: key.keyId, publicKey: key.publicKey, signature } });
    }
    if (text === null) return void res.status(400).json({ error: 'Unknown or malformed request kind.' });
    const now = Date.now();
    const locked = lockedForMs(key.keyId, now);
    if (locked > 0)
      return void res.status(429).json({ error: `Too many failed attempts for this key; wait ${Math.ceil(locked / 1000)} s.` });
    const signature = await store.sign(key.keyId, body['passphrase'], text);
    if (signature === null) {
      recordFailure(key.keyId, now);
      return void res.status(403).json({ error: 'The key could not sign: wrong passphrase, or the key is revoked.' });
    }
    clearFailures(key.keyId);
    res.status(200).json(reply(signature));
  });
  return router;
}
