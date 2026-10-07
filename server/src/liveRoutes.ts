/**
 * @layer server
 * The shared live document over REST + SSE (protocol: `@mcp/liveSync`).
 *
 *   GET  /live           SSE: `snapshot` on connect / undo / redo; `command` per mutation.
 *                        guardRead: Bearer or `?access_token=` (EventSource cannot set headers).
 *   GET  /live/snapshot  `{ seq, stateHash, document }` for resync after a gap or hash mismatch
 *   POST /command        `{ name, params?, commandId? }`; a repeated `commandId` is idempotent
 *   POST /undo, /redo    "Nothing to undo/redo." is a normal result, not an error
 */

import { Router, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { applyCommand, undo, redo } from './commandBus';
import {
  subscribeLive,
  getLiveSnapshot,
  liveSubscriberCount,
  MAX_LIVE_SUBSCRIBERS,
} from './liveDocument';
import { guardMutation, guardRead } from './security';

const KEEPALIVE_MS = 25_000;

/** @param restLimiter shared REST rate limiter (one counter across every REST route). */
export function buildLiveRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const mutationGuard = guardMutation();
  const readGuard = guardRead();

  router.get('/live', restLimiter, readGuard, (req, res) => {
    if (liveSubscriberCount() >= MAX_LIVE_SUBSCRIBERS) {
      res.status(503).json({ error: 'Too many live subscribers.' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const unsubscribe = subscribeLive(res);
    const keepaliveTimer = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepaliveTimer);
      unsubscribe();
      res.end();
    });
  });

  router.get('/live/snapshot', restLimiter, readGuard, (_req, res) => {
    res.status(200).json(getLiveSnapshot());
  });

  router.post('/command', restLimiter, mutationGuard, (req, res) => {
    const body = req.body as unknown;
    if (!isRecord(body) || !('name' in body)) {
      res.status(400).json({ error: 'Request body must be an object with a "name" field.' });
      return;
    }
    const { name, params, commandId } = body;
    if (typeof name !== 'string' || name.length === 0) {
      res.status(400).json({ error: '"name" must be a non-empty string.' });
      return;
    }
    if (commandId !== undefined && (typeof commandId !== 'string' || commandId.length === 0)) {
      res.status(400).json({ error: '"commandId" must be a non-empty string when present.' });
      return;
    }
    res.status(200).json(applyCommand(name, params ?? {}, commandId));
  });

  router.post('/undo', restLimiter, mutationGuard, (_req, res) => {
    res.status(200).json(undo());
  });

  router.post('/redo', restLimiter, mutationGuard, (_req, res) => {
    res.status(200).json(redo());
  });

  return router;
}
