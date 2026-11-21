/**
 * The desktop renderer's side of `capture_viewport` (ASC M6a). Loopback and token like `/live`:
 *   GET  /viewport/stream        SSE: one `capture` event `{ id, request }` per frame asked (guardRead: Bearer, or a single-use `?ticket=`)
 *   POST /viewport/frame/:id     `{ png: <base64>, width, height }` or `{ error: { code?, message } }` (mutation guard)
 */

import express, { Router, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { base64ToUint8Array } from '@lib/base64';
import { guardMutation, guardRead } from '../security';
import { answerFrame, registerRenderer, type CaptureAnswer } from './captureBroker';

const KEEPALIVE_MS = 25_000;
const MAX_SIDE = 4096;
const FRAME_BODY_LIMIT = '96mb';

/** The answer a POST body carries, or null when malformed. */
export function answerOfBody(body: unknown): CaptureAnswer | null {
  if (!isRecord(body)) return null;
  const error = body['error'];
  if (isRecord(error) && typeof error['message'] === 'string') {
    const code = error['code'];
    return { code: typeof code === 'string' && code.startsWith('VIEWPORT_') ? code : 'VIEWPORT_CAPTURE_FAILED', message: error['message'] };
  }
  const { png, width, height } = body;
  if (typeof png !== 'string' || typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE)
    return null;
  const bytes = base64ToUint8Array(png);
  return bytes === null || bytes.length === 0 ? null : { frame: { png: bytes, width, height } };
}

export function buildViewportRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const readGuard = guardRead();
  const mutationGuard = guardMutation();

  router.get('/viewport/stream', restLimiter, readGuard, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(':connected\n\n');
    const leave = registerRenderer((event) => res.write(`event: capture\ndata: ${JSON.stringify(event)}\n\n`));
    const keepalive = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      leave();
      res.end();
    });
  });

  router.post('/viewport/frame/:id', restLimiter, mutationGuard, express.json({ limit: FRAME_BODY_LIMIT }), (req, res) => {
    const answer = answerOfBody(req.body as unknown);
    if (answer === null)
      return void res.status(400).json({ error: 'Body must be { png (base64), width, height } or { error: { message } }.' });
    const id = req.params['id'];
    res.status(answerFrame(typeof id === 'string' ? id : '', answer) ? 200 : 404).json({ ok: true });
  });

  return router;
}
