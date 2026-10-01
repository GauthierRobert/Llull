/**
 * @layer server
 *
 * Express entry-point.
 *
 * Routes:
 *   GET  /health        — liveness probe
 *   GET  /live          — SSE stream; emits the full CadDocument on connect and after
 *                         every MCP mutation so the browser UI stays in sync
 *   ALL  /mcp           — MCP host (Streamable HTTP), the only way external agents drive the document
 *
 * No business logic lives here — the MCP router forwards external tool calls to
 * the same command registry the UI uses (architecture L1, L6).
 *
 * /live is intentionally OUTSIDE the /mcp bearer-auth middleware because
 * EventSource (browser API) cannot send Authorization headers.
 * /command, /undo, /redo are guarded by `guardMutation` (see security.ts) and rate limited.
 *
 * Env: PORT (3001), HOST (127.0.0.1), LLULL_ALLOWED_ORIGINS, LLULL_BODY_LIMIT (2mb),
 * MCP_AUTH_TOKEN, LLULL_REQUIRE_TOKEN_FOR_REST, LLULL_REST_RATE_LIMIT_*; see server/README.md.
 */

import './loadEnv';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { buildMcpRouter } from './mcp';
import { buildUiBridgeRouter } from './uiBridgeRouter';
import { inMemoryBridge } from './uiBridge';
import { subscribeLive, flushAutosave, closeAllSubscribers } from './liveDocument';
import { closeAllSessions } from './mcp';
import {
  getAllowedOrigins,
  guardMutation,
  buildRestRateLimiter,
  sanitizeFilename,
  jsonErrorHandler,
} from './security';
import type { Server } from 'http';
import { applyCommand, undo, redo } from './commandBus';
import type { ExportStlData } from '@core/commands/export';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json({ limit: process.env['LLULL_BODY_LIMIT'] ?? '2mb' }));

// Disallowed origins simply get no CORS headers (browser blocks); no error is raised.
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || getAllowedOrigins().includes(origin));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

const restLimiter = buildRestRateLimiter();
const mutationGuard = guardMutation();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/**
 * GET /live — Server-Sent Events stream of the shared CadDocument.
 *
 * Contract:
 *   - On connect: immediately emits a `snapshot` event with the current document.
 *   - On every mutation: emits a `patch` event (a `snapshot` after undo/redo).
 *   - Keepalive: sends `:keepalive\n\n` every ~25 s to prevent proxy timeouts.
 *   - On client disconnect: cleans up the subscription and the keepalive timer.
 *
 * Named SSE events:
 *   event: snapshot  data: <CadDocument>   — on connect and after undo/redo
 *   event: patch     data: <DocPatch>      — entity-level delta after each mutation
 *
 * The browser connects with:
 *   const es = new EventSource('http://localhost:3001/live');
 *   es.addEventListener('snapshot', (e) => { ... });
 *   es.addEventListener('patch', (e) => { ... });
 *
 * No auth required (EventSource cannot send Authorization headers).
 */
app.get('/live', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Register the subscriber; the initial snapshot is sent inside subscribeLive.
  const unsubscribe = subscribeLive(res);

  // Keepalive ping every 25 s — prevents proxy / load-balancer timeouts.
  const keepaliveTimer = setInterval(() => {
    try {
      res.write(':keepalive\n\n');
    } catch {
      // Connection already closed; the 'close' handler below will clean up.
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepaliveTimer);
    unsubscribe();
    res.end();
  });
});

// ---------------------------------------------------------------------------
// REST command bus — OUTSIDE /mcp auth (browser sends no Authorization header)
// ---------------------------------------------------------------------------

/**
 * POST /command — apply a named command to the shared live document.
 *
 * Request body: { name: string, params?: unknown }
 *
 * Response 200: { summary, affected, isError, data?, canUndo, canRedo }
 *   - summary   — human/AI readable description of what happened.
 *   - affected  — ids of entities created or changed ([] for queries/no-ops).
 *   - isError   — true only when the command name is not registered.
 *   - data      — present only for query commands (e.g. measure_*).
 *   - canUndo   — whether undo is now available.
 *   - canRedo   — whether redo is now available.
 * Response 400: { error } — missing or malformed body.
 *
 * Mutations automatically broadcast to all /live SSE subscribers.
 * Guarded by `guardMutation` (origin allowlist / bearer token) and rate limited.
 */
app.post('/command', restLimiter, mutationGuard, (req: Request, res: Response) => {
  const body = req.body as unknown;
  if (typeof body !== 'object' || body === null || !('name' in body)) {
    res.status(400).json({ error: 'Request body must be an object with a "name" field.' });
    return;
  }
  const { name, params } = body as { name: unknown; params?: unknown };
  if (typeof name !== 'string' || name.length === 0) {
    res.status(400).json({ error: '"name" must be a non-empty string.' });
    return;
  }
  const result = applyCommand(name, params ?? {});
  res.status(200).json(result);
});

/**
 * POST /undo — undo the last mutating command.
 *
 * No request body required.
 * Response 200: { summary, affected: [], isError: false, canUndo, canRedo }
 *
 * If the undo stack is empty, returns summary "Nothing to undo." — not an error.
 * Broadcasts the restored document to all /live SSE subscribers when a step is available.
 */
app.post('/undo', restLimiter, mutationGuard, (_req: Request, res: Response) => {
  res.status(200).json(undo());
});

/**
 * POST /redo — redo the last undone command.
 *
 * No request body required.
 * Response 200: { summary, affected: [], isError: false, canUndo, canRedo }
 *
 * If the redo stack is empty, returns summary "Nothing to redo." — not an error.
 * Broadcasts the redone document to all /live SSE subscribers when a step is available.
 */
app.post('/redo', restLimiter, mutationGuard, (_req: Request, res: Response) => {
  res.status(200).json(redo());
});

// ---------------------------------------------------------------------------
// Export download routes — OUTSIDE /mcp auth (browser downloads cannot send
// Authorization headers — same rationale as /live and /command).
// ---------------------------------------------------------------------------

/**
 * GET /export/stl — stream the shared live document as a downloadable STL file.
 *
 * Query params:
 *   format  — 'ascii' (default) or 'binary'. Anything other than 'binary' → 'ascii'.
 *   name    — solid name / download filename; sanitized to [A-Za-z0-9._-], max 64 chars
 *             (default 'llull').  The response Content-Disposition will be
 *             `attachment; filename="<name>.stl"`.
 *
 * Response (200):
 *   Content-Type: model/stl
 *   Content-Disposition: attachment; filename="<name>.stl"
 *   Body: raw ASCII STL text (ascii) OR raw binary STL bytes (binary).
 *
 * An empty or all-2D document produces a valid empty STL (triangleCount=0) — still 200.
 * If the command result is missing data, responds 500 with { error }.
 *
 * No auth required.
 * CORS already allows GET from http://localhost:5173.
 */
app.get('/export/stl', restLimiter, (req: Request, res: Response) => {
  const rawFormat = req.query['format'];
  const format: 'ascii' | 'binary' = rawFormat === 'binary' ? 'binary' : 'ascii';

  const name = sanitizeFilename(req.query['name']);

  const result = applyCommand('export_stl', { format, name });

  if (!result.data) {
    res.status(500).json({ error: 'export_stl returned no data.' });
    return;
  }

  const data = result.data as ExportStlData;

  res.setHeader('Content-Disposition', `attachment; filename="${name}.stl"`);
  res.setHeader('Content-Type', 'model/stl');

  if (data.format === 'binary') {
    if (!data.stlBase64) {
      res.status(500).json({ error: 'export_stl binary result missing stlBase64.' });
      return;
    }
    const buf = Buffer.from(data.stlBase64, 'base64');
    res.setHeader('Content-Length', buf.length);
    res.status(200).end(buf);
  } else {
    const body = data.stl ?? '';
    res.status(200).send(body);
  }
});

// UI↔MCP live-sync bridge routes — guarded by the same bearer auth as /mcp.
// See server/src/uiBridgeRouter.ts for the implementation.
app.use('/ui-bridge', buildUiBridgeRouter());

// MCP endpoint — Streamable HTTP, guarded by bearer auth + rate limiting.
// See server/src/mcp.ts for the implementation.
app.use('/mcp', buildMcpRouter(inMemoryBridge));

app.use(jsonErrorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3001;

/**
 * Bind address. Default 127.0.0.1: llull is a local tool and /command is unauthenticated for
 * the browser UI, so it must not be reachable from the network unless explicitly opted in
 * (`HOST=0.0.0.0`, ideally together with MCP_AUTH_TOKEN).
 */
const HOST = process.env['HOST'] ?? '127.0.0.1';

/** Stop accepting connections, end SSE/MCP streams, flush autosave. Resolves when closed. */
export async function shutdown(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  closeAllSubscribers();
  await closeAllSessions();
  flushAutosave();
  server.closeIdleConnections();
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]);
  server.closeAllConnections();
}

/** Listen on HOST:PORT, log startup, install SIGTERM/SIGINT handlers. */
export function startServer(port: number = PORT, host: string = HOST): Server {
  const server = app.listen(port, host, () => {
    console.warn(`[llull-server] listening on http://${host}:${port}`);
  });
  let stopping = false;
  const onSignal = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.warn(`[llull-server] ${signal} received, shutting down`);
    void shutdown(server).then(() => process.exit(0));
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  return server;
}

/**
 * Only start listening when this file is the process entry-point (tests import `app` and use
 * supertest's ephemeral server). `TEST=true` is an explicit escape hatch.
 */
if (require.main === module && process.env['TEST'] !== 'true') {
  startServer();
}

export { app };
