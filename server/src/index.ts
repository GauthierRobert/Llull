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
 * CORS already permits GET from http://localhost:5173.
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { buildMcpRouter } from './mcp';
import { subscribeLive } from './liveDocument';
import { applyCommand, undo, redo } from './commandBus';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json({ limit: '2mb' }));

// Allow the Vite dev server and common localhost origins.
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Postman, same-origin).
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

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
 *   - On connect: immediately emits one SSE message containing the current
 *     document snapshot: `data: <JSON>\n\n`
 *   - On every MCP mutation: emits a new message with the updated document.
 *   - Keepalive: sends `:keepalive\n\n` every ~25 s to prevent proxy timeouts.
 *   - On client disconnect: cleans up the subscription and the keepalive timer.
 *
 * Message format (standard SSE `data:` event — no `event:` field):
 *   data: <JSON-serialized CadDocument>\n\n
 *
 * The browser connects with:
 *   const es = new EventSource('http://localhost:3001/live');
 *   es.onmessage = (e) => { const doc = JSON.parse(e.data); ... };
 *
 * No auth required (EventSource cannot send Authorization headers).
 * CORS already allows GET from http://localhost:5173.
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
 * CORS already allows POST from http://localhost:5173.
 */
app.post('/command', (req: Request, res: Response) => {
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
app.post('/undo', (_req: Request, res: Response) => {
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
app.post('/redo', (_req: Request, res: Response) => {
  res.status(200).json(redo());
});

// MCP endpoint — Streamable HTTP, guarded by bearer auth + rate limiting.
// See server/src/mcp.ts for the implementation.
app.use('/mcp', buildMcpRouter());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3001;

/**
 * Only start listening when this file is the process entry-point.
 * When imported by tests (supertest, vitest) the module-level `app` is exported
 * without binding a port — supertest creates its own ephemeral server.
 *
 * Detection: `require.main === module` works for CommonJS entry-points (tsx / node dist/).
 * The `TEST` env var provides an explicit escape hatch for environments where the
 * detection is unreliable.
 */
if (require.main === module && process.env['TEST'] !== 'true') {
  app.listen(PORT, () => {
    if (!process.env['MCP_AUTH_TOKEN']) {
      console.warn(
        '[warn] MCP_AUTH_TOKEN is not set — /mcp endpoint is unprotected. Set it in production.',
      );
    }
  });
}

export { app };
