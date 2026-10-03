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
 * MCP_AUTH_TOKEN, LLULL_REQUIRE_TOKEN_FOR_REST, LLULL_ALLOWED_HOSTS, LLULL_ALLOW_UNAUTHENTICATED, LLULL_REST_RATE_LIMIT_*; see server/README.md.
 */

import './plugins'; // must stay first: installs domain plugins before liveDocument loads
import './loadEnv';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { buildMcpRouter } from './mcp';
import { exchangeOptionsFromEnv } from './pythonExchange';
import { getActiveKernelName, installGeometryKernel } from './geometryKernel';
import { exportStepFile } from '@mcp/index';
import {
  subscribeLive,
  getLiveSnapshot,
  flushAutosave,
  stopAutosave,
  closeAllSubscribers,
  getLiveDoc,
} from './liveDocument';
import { closeAllSessions } from './mcp';
import {
  getAllowedOrigins,
  guardMutation,
  hostAllowlist,
  checkBindSafety,
  buildRestRateLimiter,
  sanitizeFilename,
  jsonErrorHandler,
  isLoopbackAddress,
} from './security';
import type { Server } from 'http';
import { applyCommand, undo, redo } from './commandBus';
import type { ExportStlData } from '@core/commands/export';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(hostAllowlist());

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
  res.json({ status: 'ok', kernel: getActiveKernelName() });
});

/**
 * GET /live — Server-Sent Events stream of the shared CadDocument.
 *
 * Contract:
 *   - On connect: immediately emits a `snapshot` event with the current document.
 *   - On every mutating command: emits a `command` event (the log entry); after undo/redo or a
 *     bulk replacement: a `snapshot` event (see `@mcp/liveSync`).
 *   - Keepalive: sends `:keepalive\n\n` every ~25 s to prevent proxy timeouts.
 *   - On client disconnect: cleans up the subscription and the keepalive timer.
 *
 * Named SSE events:
 *   event: snapshot  data: { seq, stateHash, document } — on connect and after undo/redo
 *   event: command   data: { seq, name, params, stateHash } — after each mutating command
 *
 * Clients re-run each `command` through `execute` and verify `stateHash`; on a seq gap or hash
 * mismatch they fetch `GET /live/snapshot`.
 *
 * The browser connects with:
 *   const es = new EventSource('http://localhost:3001/live');
 *   es.addEventListener('snapshot', (e) => { ... });
 *   es.addEventListener('command', (e) => { ... });
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

/**
 * GET /live/snapshot — the current document with its log position `{ seq, stateHash, document }`.
 * Used by clients to resynchronise after a missed or mismatching `command` event.
 */
app.get('/live/snapshot', restLimiter, (_req: Request, res: Response) => {
  res.status(200).json(getLiveSnapshot());
});

// ---------------------------------------------------------------------------
// REST command bus — OUTSIDE /mcp auth (browser sends no Authorization header)
// ---------------------------------------------------------------------------

/**
 * POST /command — apply a named command to the shared live document.
 *
 * Request body: { name: string, params?: unknown, commandId?: string }
 *   commandId makes retries idempotent: a repeated id returns the first result without re-applying.
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
  const { name, params, commandId } = body as {
    name: unknown;
    params?: unknown;
    commandId?: unknown;
  };
  if (typeof name !== 'string' || name.length === 0) {
    res.status(400).json({ error: '"name" must be a non-empty string.' });
    return;
  }
  if (commandId !== undefined && (typeof commandId !== 'string' || commandId.length === 0)) {
    res.status(400).json({ error: '"commandId" must be a non-empty string when present.' });
    return;
  }
  const result = applyCommand(name, params ?? {}, commandId);
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

  if (data.format === 'binary' && !data.stlBase64) {
    res.status(500).json({ error: 'export_stl binary result missing stlBase64.' });
    return;
  }
  sendDownload(
    res,
    `${name}.stl`,
    'model/stl',
    data.format === 'binary' ? Buffer.from(data.stlBase64 ?? '', 'base64') : (data.stl ?? ''),
  );
});

/** The one file-download responder: attachment headers + a text (send) or binary (end) body. */
function sendDownload(
  res: Response,
  fileName: string,
  contentType: string,
  body: string | Buffer,
): void {
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', contentType);
  if (typeof body === 'string') {
    res.status(200).send(body);
    return;
  }
  res.setHeader('Content-Length', body.length);
  res.status(200).end(body);
}

/** Python bridge for STEP / parametric code (shared by /export/step and the MCP exchange tools). */
const exchange = exchangeOptionsFromEnv();

function exportLanguage(raw: unknown): 'cadquery' | 'build123d' | 'openscad' | 'freecad' {
  return raw === 'build123d' || raw === 'openscad' || raw === 'freecad' ? raw : 'cadquery';
}

/**
 * GET /export/code — download the model as parametric source code (export_code).
 * Query: language = cadquery (default) | build123d | openscad | freecad; name = file base name.
 */
app.get('/export/code', restLimiter, (req: Request, res: Response) => {
  const name = sanitizeFilename(req.query['name'], 'model');
  const result = applyCommand('export_code', {
    language: exportLanguage(req.query['language']),
    name,
  });
  const data = result.data as { text?: string; fileName?: string } | undefined;
  if (data?.text === undefined || data.fileName === undefined) {
    res.status(500).json({ error: result.summary });
    return;
  }
  sendDownload(res, data.fileName, 'text/plain; charset=utf-8', data.text);
});

/**
 * GET /export/step — download the model as an exact B-rep STEP file (needs the Python bridge).
 * Query: name = file base name; language = cadquery (default) | build123d. 503 when Python is
 * not configured, 500 with { error } when the bridge fails.
 */
app.get('/export/step', restLimiter, (req: Request, res: Response) => {
  const port = exchange.port;
  if (port === null) {
    res.status(503).json({ error: 'STEP export needs the Python bridge (LLULL_PYTHON is off).' });
    return;
  }
  const name = sanitizeFilename(req.query['name'], 'model');
  exportStepFile(getLiveDoc, port, { name, language: req.query['language'], save: false })
    .then((file) => {
      if ('error' in file) {
        res.status(500).json({ error: file.error });
        return;
      }
      sendDownload(res, file.fileName, 'model/step', Buffer.from(file.stepBase64, 'base64'));
    })
    .catch((error: unknown) => {
      res.status(500).json({
        error: `export_step failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
});

// MCP endpoint — Streamable HTTP, guarded by bearer auth + rate limiting.
// See server/src/mcp.ts for the implementation.
app.use('/mcp', buildMcpRouter(exchange));

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

const SESSION_CLOSE_TIMEOUT_MS = 3_000;
const DRAIN_TIMEOUT_MS = 5_000;

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Stop accepting connections, end SSE/MCP streams, drain, flush autosave. Resolves when closed.
 * Autosave is switched to synchronous-write mode first so an edit finishing mid-drain is persisted.
 */
export async function shutdown(server: Server): Promise<void> {
  stopAutosave();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  closeAllSubscribers();
  await Promise.race([closeAllSessions(), delay(SESSION_CLOSE_TIMEOUT_MS)]);
  server.closeIdleConnections();
  await Promise.race([closed, delay(DRAIN_TIMEOUT_MS)]);
  server.closeAllConnections();
  flushAutosave();
}

/** Listen on HOST:PORT, log startup, install SIGTERM/SIGINT/uncaughtException handlers. */
export function startServer(port: number = PORT, host: string = HOST): Server {
  const refusal = checkBindSafety(host);
  if (refusal !== null) throw new Error(refusal);
  if (!isLoopbackAddress(host) && !process.env['MCP_AUTH_TOKEN']) {
    console.warn(
      '[llull-server] WARNING: network-exposed without MCP_AUTH_TOKEN (LLULL_ALLOW_UNAUTHENTICATED=true).',
    );
  }
  void installGeometryKernel();
  const server = app.listen(port, host, () => {
    console.warn(`[llull-server] listening on http://${host}:${port}`);
  });
  let stopping = false;
  const onSignal = (signal: string): void => {
    if (stopping) {
      console.warn(`[llull-server] second ${signal}, forcing exit`);
      flushAutosave();
      process.exit(1);
    }
    stopping = true;
    console.warn(`[llull-server] ${signal} received, shutting down`);
    shutdown(server)
      .catch((err: unknown) => console.error('[llull-server] shutdown failed:', err))
      .finally(() => {
        flushAutosave();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('uncaughtException', (err: Error) => {
    console.error('[llull-server] uncaughtException:', err);
    flushAutosave();
    process.exit(1);
  });
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
