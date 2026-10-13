/**
 * The live document over REST + SSE (protocol: `@mcp/liveSync`).
 *   GET  /live           SSE: `snapshot` on connect / undo / redo; `command` per mutation.
 *                        guardRead: Bearer or `?access_token=` (EventSource cannot set headers).
 *   GET  /live/snapshot  `{ seq, stateHash, document }` for resync after a gap or hash mismatch
 *   POST /command        `{ name, params?, commandId? }`; a repeated `commandId` is idempotent
 *   POST /undo, /redo    "Nothing to undo/redo." is a normal result, not an error
 */

import { Router, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { applyCommand, undo, redo } from './commandBus';
import { subscribeLive, getLiveSnapshot, liveSubscriberCount, MAX_LIVE_SUBSCRIBERS, liveMaxPerClient } from './liveDocument';
import { guardMutation, guardRead } from './security';
import { actorOf } from './audit';

const KEEPALIVE_MS = 25_000;

export function buildLiveRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const streamsPerClient = new Map<string, number>();
  const mutationGuard = guardMutation();
  const readGuard = guardRead();

  router.get('/live', restLimiter, readGuard, (req, res) => {
    if (liveSubscriberCount() >= MAX_LIVE_SUBSCRIBERS) return void res.status(503).json({ error: 'Too many live subscribers.' });
    const client = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const open = streamsPerClient.get(client) ?? 0;
    if (open >= liveMaxPerClient()) return void res.status(429).json({ error: 'Too many live streams from this client.' });
    streamsPerClient.set(client, open + 1);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const unsubscribe = subscribeLive(res);
    const keepaliveTimer = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      const remaining = (streamsPerClient.get(client) ?? 1) - 1;
      if (remaining > 0) streamsPerClient.set(client, remaining);
      else streamsPerClient.delete(client);
      clearInterval(keepaliveTimer);
      unsubscribe();
      res.end();
    });
  });

  router.get('/live/snapshot', restLimiter, readGuard, (_req, res) => void res.status(200).json(getLiveSnapshot()));

  router.post('/command', restLimiter, mutationGuard, (req, res) => {
    const body = req.body as unknown;
    if (!isRecord(body) || !('name' in body))
      return void res.status(400).json({ error: 'Request body must be an object with a "name" field.' });
    const { name, params, commandId } = body;
    if (typeof name !== 'string' || name.length === 0) return void res.status(400).json({ error: '"name" must be a non-empty string.' });
    if (commandId !== undefined && (typeof commandId !== 'string' || commandId.length === 0)) {
      return void res.status(400).json({ error: '"commandId" must be a non-empty string when present.' });
    }
    res.status(200).json(applyCommand(name, params ?? {}, commandId, actorOf(res, body.client === 'cli' ? 'cli' : 'rest')));
  });

  router.post('/undo', restLimiter, mutationGuard, (_req, res) => void res.status(200).json(undo(actorOf(res, 'rest'))));
  router.post('/redo', restLimiter, mutationGuard, (_req, res) => void res.status(200).json(redo(actorOf(res, 'rest'))));

  return router;
}
