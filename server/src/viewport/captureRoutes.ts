/**
 * The desktop renderer's side of `capture_viewport` (ASC M6a). Loopback and token like `/live`:
 *   GET  /viewport/stream        SSE: `capture { id, request, documentHash }` per frame asked, `cancel { id }` when it no longer matters
 *                                (guardRead: Bearer, or a single-use `?ticket=`; a token is required even where /live is open)
 *   POST /viewport/frame/:id     `{ png: <base64>, width, height }` or `{ error: { code?, message } }` (mutation guard). An id nobody waits for is 404 before the body is read;
 *                                the body is capped by what the asked size can reach; a PNG whose signature or IHDR size is not the asked one is 400 and ends the request VIEWPORT_CAPTURE_FAILED.
 */

import express, { Router, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { base64ToUint8Array } from '@lib/base64';
import { pngHeader } from '@lib/pngHeader';
import { guardMutation, guardRead, isInsecureNoToken } from '../security';
import { answerFrame, pendingRequest, registerRenderer, type CaptureAnswer } from './captureBroker';

const KEEPALIVE_MS = 25_000;
const BYTES_PER_PIXEL = 4;
/** Base64 grows 4/3; the rest is the JSON around it. */
const BODY_SLACK_BYTES = 4096;

const failure = (message: string): CaptureAnswer => ({ code: 'VIEWPORT_CAPTURE_FAILED', message });

/**
 * The answer a POST body carries, or null when malformed. A frame must be a PNG of exactly `expected` size (the size that was asked).
 * @failure not base64, not a PNG, IHDR size differs from `expected` or from the declared width / height -> null
 */
export function answerOfBody(body: unknown, expected: { readonly width: number; readonly height: number }): CaptureAnswer | null {
  if (!isRecord(body)) return null;
  const error = body['error'];
  if (isRecord(error) && typeof error['message'] === 'string') {
    const code = error['code'];
    return { code: typeof code === 'string' && code.startsWith('VIEWPORT_') ? code : 'VIEWPORT_CAPTURE_FAILED', message: error['message'] };
  }
  const { png, width, height } = body;
  if (typeof png !== 'string' || typeof width !== 'number' || typeof height !== 'number') return null;
  const bytes = base64ToUint8Array(png);
  if (bytes === null) return null;
  const header = pngHeader(bytes);
  const sizes = [header, { width, height }];
  if (header === null || sizes.some((size) => size?.width !== expected.width || size?.height !== expected.height)) return null;
  return { frame: { png: bytes, width: header.width, height: header.height } };
}

/** Largest body a frame of the asked size can have; an unknown id is refused here, before any body is parsed. */
const frameBody: RequestHandler = (req, res, next) => {
  const id = req.params['id'];
  const asked = typeof id === 'string' ? pendingRequest(id) : undefined;
  if (asked === undefined) return void res.status(404).json({ error: 'No capture is waiting under that id.' });
  const limit = Math.ceil((asked.width * asked.height * BYTES_PER_PIXEL * 4) / 3) + BODY_SLACK_BYTES;
  express.json({ limit })(req, res, next);
};

/** The stream needs a token even where /live is open (it hands out nothing but is a control channel of the app). */
const streamNeedsToken: RequestHandler = (_req, res, next) => {
  const token = process.env['LLULL_AUTH_TOKEN'];
  if ((token === undefined || token === '') && !isInsecureNoToken())
    return void res.status(401).json({ error: 'The viewport stream needs the launch token.', code: 'SEC_TOKEN_REQUIRED' });
  next();
};

export function buildViewportRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const readGuard = guardRead();
  const mutationGuard = guardMutation();

  router.get('/viewport/stream', restLimiter, streamNeedsToken, readGuard, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(':connected\n\n');
    const leave = registerRenderer((message) =>
      res.write(`event: ${message.type}\ndata: ${JSON.stringify(message.type === 'capture' ? message.event : { id: message.id })}\n\n`),
    );
    const keepalive = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      leave();
      res.end();
    });
  });

  router.post('/viewport/frame/:id', restLimiter, mutationGuard, frameBody, (req, res) => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
    const asked = pendingRequest(id);
    const answer = asked === undefined ? null : answerOfBody(req.body as unknown, asked);
    if (asked !== undefined && answer === null) {
      answerFrame(id, failure('the viewport answered with a picture that is not a PNG of the size asked'));
      return void res
        .status(400)
        .json({
          error: 'Body must be { png (base64 PNG of the asked size), width, height } or { error: { message } }.',
          code: 'VIEWPORT_CAPTURE_FAILED',
        });
    }
    res.status(answer !== null && answerFrame(id, answer) ? 200 : 404).json({ ok: true });
  });

  return router;
}
