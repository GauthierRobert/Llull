/**
 * The live document over REST + SSE (protocol: `@protocol/liveSync`).
 *   GET  /live           SSE: `snapshot` on connect / undo / redo; `command` per mutation.
 *                        guardRead: Bearer, or a single-use `?ticket=` (EventSource cannot set headers).
 *   POST /live/ticket    `{ ticket, expiresInMs }`: 30 s single-use ticket (header auth only)
 *   GET  /live/snapshot  `{ seq, stateHash, document }` for resync after a gap or hash mismatch
 *   POST /command        `{ name, params?, commandId? }`; a repeated `commandId` is idempotent
 *   POST /undo, /redo    "Nothing to undo/redo." is a normal result, not an error
 */

import { Router, type Request, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { applyCommand, undo, redo } from './commandBus';
import { getLiveDoc, subscribeLive, getLiveSnapshot, liveSubscriberCount, MAX_LIVE_SUBSCRIBERS, liveMaxPerClient } from './liveDocument';
import { guardMutation, guardRead, guardTicketIssue, isLocalPeer } from './security';
import { redactLicensedOutcome } from '@protocol/index';
import { TICKET_TTL_MS, issueTicket } from './tickets';

const KEEPALIVE_MS = 25_000;

/**
 * Per-client key for the /live stream cap, or null when the client cannot be told apart: behind a proxy every client
 * shares the proxy's address, so only the global cap applies.
 */
function liveClientKey(req: Request): string | null {
  const proxied = req.headers['x-forwarded-for'] !== undefined || req.headers['forwarded'] !== undefined;
  if (proxied) return null;
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function buildLiveRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const streamsPerClient = new Map<string, number>();
  const mutationGuard = guardMutation();
  const readGuard = guardRead();
  const ticketGuard = guardTicketIssue();

  router.get('/live', restLimiter, readGuard, (req, res) => {
    if (liveSubscriberCount() >= MAX_LIVE_SUBSCRIBERS) return void res.status(503).json({ error: 'Too many live subscribers.' });
    const client = liveClientKey(req);
    const open = client === null ? 0 : (streamsPerClient.get(client) ?? 0);
    if (open >= liveMaxPerClient()) return void res.status(429).json({ error: 'Too many live streams from this client.' });
    if (client !== null) streamsPerClient.set(client, open + 1);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const unsubscribe = subscribeLive(res);
    const keepaliveTimer = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      if (client !== null) {
        const remaining = (streamsPerClient.get(client) ?? 1) - 1;
        if (remaining > 0) streamsPerClient.set(client, remaining);
        else streamsPerClient.delete(client);
      }
      clearInterval(keepaliveTimer);
      unsubscribe();
      res.end();
    });
  });

  router.post('/live/ticket', restLimiter, ticketGuard, (req, res) => {
    const ticket = issueTicket(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    if (ticket === null) return void res.status(503).json({ error: 'Too many outstanding tickets.' });
    res.status(200).json({ ticket, expiresInMs: TICKET_TTL_MS });
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
    const applied = applyCommand(name, params ?? {}, commandId, body.client === 'cli' ? 'cli' : 'rest');
    res.status(200).json(isLocalPeer(req) ? applied : redactLicensedOutcome(getLiveDoc(), name, params, applied));
  });

  router.post('/undo', restLimiter, mutationGuard, (_req, res) => void res.status(200).json(undo()));
  router.post('/redo', restLimiter, mutationGuard, (_req, res) => void res.status(200).json(redo()));

  return router;
}
