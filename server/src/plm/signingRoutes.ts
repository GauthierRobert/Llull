/**
 * Local signing endpoints for the desktop app (09 PLM TR-PLM-08): the human types a key passphrase in the app, the backend signs with the key store of
 * this machine and returns the signature; nothing is stored and the passphrase is never logged or returned. Typed requests only, so the server (not the
 * caller) builds the bytes it signs wherever it can:
 *   GET  /signing/keys   enrolled public keys (userId, name, public key, revoked, trusted)
 *   POST /signing/sign   { kind: 'gate', keyId, passphrase, command, params, nonce }   a plm human act: the payload comes from `plm_act_payload` on the live document
 *                        { kind: 'manifest', keyId, passphrase, revision, manifestKind?, meaning? }   the canonical manifest bytes come from `release_manifest`
 *                        { kind: 'payload', keyId, passphrase, payloadSha256 }   an act of another gap (dispose_margin, accept_pmi_review) whose payload hash the
 *                        client computed from the shown row; the signed bytes are context-prefixed (`llull-gate-v1:`), so they cannot be replayed as a manifest
 * Five wrong passphrases for a key within a minute lock it for the rest of the minute (429).
 */

import { Router, type RequestHandler } from 'express';
import { execute } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
import { getLiveDoc } from '../liveDocument';
import { guardMutation, guardRead } from '../security';
import { createKeyStore } from './keyStore';
import { GATE_CONTEXT } from './signaturePort';
import { createTrustStore } from './trustStore';

const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();

const recent = (keyId: string, now: number): number[] => (failures.get(keyId) ?? []).filter((at) => now - at < WINDOW_MS);

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
    } else if (kind === 'payload' && typeof body['payloadSha256'] === 'string' && /^[0-9a-f]{64}$/.test(body['payloadSha256'])) {
      text = `${GATE_CONTEXT}${body['payloadSha256']}`;
      reply = (signature) => ({ signature: { alg: 'Ed25519', keyId: key.keyId, publicKey: key.publicKey, signature } });
    }
    if (text === null) return void res.status(400).json({ error: 'Unknown or malformed request kind.' });
    const now = Date.now();
    if (recent(key.keyId, now).length >= MAX_FAILURES)
      return void res.status(429).json({ error: 'Too many failed attempts for this key; wait a minute.' });
    const signature = await store.sign(key.keyId, body['passphrase'], text);
    if (signature === null) {
      failures.set(key.keyId, [...recent(key.keyId, now), now]);
      return void res.status(403).json({ error: 'The key could not sign: wrong passphrase, or the key is revoked.' });
    }
    failures.delete(key.keyId);
    res.status(200).json(reply(signature));
  });
  return router;
}
