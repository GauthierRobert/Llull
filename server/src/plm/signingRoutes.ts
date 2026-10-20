/**
 * Local signing endpoints for the desktop app (09 PLM TR-PLM-08): the human types a key passphrase in the app, the backend signs with the key
 * store of this machine and returns the signature; nothing is stored and the passphrase is never logged or returned.
 *   GET  /signing/keys   registered public keys (userId, name, public key, revoked)
 *   POST /signing/sign   { keyId, passphrase, payloadSha256 | message } -> { signature }
 *                        payloadSha256: a human-gate confirmation object { alg, keyId, publicKey, signature } over the UTF-8 hex payload hash
 *                        message: a raw Ed25519 signature (hex) over the UTF-8 message (a canonical manifest for record_signature)
 */

import { Router, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { guardMutation, guardRead } from '../security';
import { createKeyStore } from './keyStore';

export function buildSigningRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.get('/signing/keys', restLimiter, guardRead(), (_req, res) => void res.status(200).json({ keys: createKeyStore().list() }));
  router.post('/signing/sign', restLimiter, guardMutation(), (req, res) => {
    const body: unknown = req.body;
    if (!isRecord(body) || typeof body['keyId'] !== 'string' || typeof body['passphrase'] !== 'string')
      return void res.status(400).json({ error: 'Body needs keyId and passphrase (strings) and payloadSha256 or message.' });
    const store = createKeyStore();
    const key = store.find(body['keyId']);
    const text =
      typeof body['payloadSha256'] === 'string' ? body['payloadSha256'] : typeof body['message'] === 'string' ? body['message'] : null;
    if (key === undefined || text === null)
      return void res.status(400).json({ error: 'Unknown key, or neither payloadSha256 nor message given.' });
    const signature = store.sign(key.keyId, body['passphrase'], text);
    if (signature === null) return void res.status(403).json({ error: 'The key could not sign: wrong passphrase, or the key is revoked.' });
    const confirmation = { alg: 'Ed25519', keyId: key.keyId, publicKey: key.publicKey, signature };
    res
      .status(200)
      .json(
        typeof body['payloadSha256'] === 'string'
          ? { signature: confirmation }
          : { signature, keyId: key.keyId, publicKey: key.publicKey, signer: { userId: key.userId, name: key.name } },
      );
  });
  return router;
}
