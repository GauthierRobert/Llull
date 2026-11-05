/**
 * Recovery slots over REST (A-08, FR-DSF-05..07, FR-DSF-23). Host state, never a document change: opening or restoring a document is
 * `hold`, then the `load_document` command, then `bind` / `adopt` (or `release` when the load failed).
 *   GET  /recovery            `{ slots: [{ ...meta, active }] }`, newest first
 *   GET  /recovery/:id        `{ meta, json }`
 *   POST /recovery/hold       `{}` BEFORE loading another document: the previous slot is flushed and the load stays out of it
 *   POST /recovery/release    `{}` the load failed: the previous document keeps its slot and takes the changes made meanwhile
 *   POST /recovery/bind       `{ path: string | null, dropPrevious }` AFTER the load succeeded: the live document belongs to that path's slot
 *   POST /recovery/saved      `{ stateHash }` the live document equals its file: the slot is removed (no-op when the document changed since)
 *   POST /recovery/adopt      `{ id }` the live document is the restored slot `id`
 *   POST /recovery/discard    `{ id }`
 *   POST /recovery/offline    `{ json, path, changeCount }` edits made while the backend was unreachable, kept as their own slot
 */

import { Router, type RequestHandler } from 'express';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';
import { documentHash } from '@protocol/liveSync';
import { getLiveDoc, publishDocumentPath, recoverySession, recoveryStore } from './liveDocument';
import { type SlotBase, isSlotId } from './recovery';
import { guardMutation, guardRead } from './security';

const baseOf = (body: Record<string, unknown>): SlotBase | null => {
  const { baseSha256, baseSize } = body;
  return typeof baseSha256 === 'string' && /^[0-9a-f]{64}$/.test(baseSha256) && typeof baseSize === 'number' && baseSize >= 0
    ? { sha256: baseSha256, size: baseSize }
    : null;
};

const bodyOf = (body: unknown): Record<string, unknown> => (isRecord(body) ? body : {});

export function buildRecoveryRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const read = guardRead();
  const mutate = guardMutation();

  router.get('/recovery', restLimiter, read, (_req, res) => {
    const active = recoverySession.current().id;
    res.json({ slots: recoveryStore.list().map((meta) => ({ ...meta, active: meta.id === active })) });
  });

  router.get('/recovery/:id', restLimiter, read, (req, res) => {
    const found = recoveryStore.read(String(req.params['id']));
    if (found === null) return void res.status(404).json({ error: 'No such recovery slot.' });
    res.json(found);
  });

  router.post('/recovery/hold', restLimiter, mutate, (_req, res) => {
    recoverySession.hold();
    res.json({ ok: true });
  });

  router.post('/recovery/release', restLimiter, mutate, (_req, res) => {
    recoverySession.release();
    res.json({ ok: true });
  });

  router.post('/recovery/bind', restLimiter, mutate, (req, res) => {
    const { path: documentPath, dropPrevious } = bodyOf(req.body);
    const base = baseOf(bodyOf(req.body));
    if (documentPath !== null && (typeof documentPath !== 'string' || documentPath === '')) {
      recoverySession.release(); // a refused bind still ends the hold
      return void res.status(400).json({ error: 'path must be a file path or null.' });
    }
    recoverySession.bind(documentPath, dropPrevious === true, base);
    publishDocumentPath();
    res.json({ ok: true, slot: recoverySession.current().id });
  });

  router.post('/recovery/saved', restLimiter, mutate, (req, res) => {
    const { stateHash } = bodyOf(req.body);
    if ('baseSha256' in bodyOf(req.body)) recoverySession.setBase(baseOf(bodyOf(req.body)));
    const matches = typeof stateHash === 'string' && stateHash === documentHash(getLiveDoc());
    if (matches) recoverySession.markSaved();
    res.json({ ok: true, removed: matches });
  });

  router.post('/recovery/adopt', restLimiter, mutate, (req, res) => {
    const { id } = bodyOf(req.body);
    const meta = typeof id === 'string' && isSlotId(id) ? recoverySession.adopt(id, getLiveDoc()) : null;
    if (meta === null) {
      recoverySession.release(); // an unknown slot still ends the hold (adopt itself does when it ran)
      return void res.status(404).json({ error: 'No such recovery slot.' });
    }
    publishDocumentPath();
    res.json({ ok: true, meta });
  });

  router.post('/recovery/discard', restLimiter, mutate, (req, res) => {
    const { id } = bodyOf(req.body);
    if (typeof id !== 'string' || !isSlotId(id)) return void res.status(400).json({ error: 'id must be a slot id.' });
    if (id === recoverySession.current().id) return void res.status(409).json({ error: 'That slot belongs to the open document.' });
    recoveryStore.remove(id);
    res.json({ ok: true });
  });

  router.post('/recovery/offline', restLimiter, mutate, (req, res) => {
    const { json, path: documentPath, changeCount } = bodyOf(req.body);
    if (typeof json !== 'string') return void res.status(400).json({ error: 'json must be a serialized document.' });
    try {
      deserializeDocument(json);
    } catch (err) {
      return void res.status(400).json({ error: `json is not a document: ${errorMessage(err)}` });
    }
    const meta = recoveryStore.addOffline(
      json,
      typeof documentPath === 'string' ? documentPath : recoverySession.current().path, // the document the edits belong to
      typeof changeCount === 'number' ? changeCount : 0,
      new Date(),
      recoverySession.current().base,
    );
    res.json({ ok: true, meta });
  });

  return router;
}
