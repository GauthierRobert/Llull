/**
 * @layer server
 *
 * MCP endpoint — Streamable HTTP transport over the llull command registry.
 *
 * Architecture:
 * - ALL tool logic is delegated to `core/mcp` (`buildMcpTools`, `applyMcpToolCall`).
 * - This file owns ONLY the transport wiring, auth middleware, and rate limiting.
 * - No command/geometry logic lives here (architecture L6).
 *
 * Session model (v3 — shared live document):
 * - Each MCP `initialize` handshake (POST without `mcp-session-id`) creates a new
 *   session entry: a `StreamableHTTPServerTransport` with a UUID session id, and a
 *   bound `Server` whose handlers read/write the SINGLE shared `CadDocument` from
 *   `liveDocument.ts` via `getLiveDoc` / `setLiveDoc`.
 * - Subsequent requests carry the `mcp-session-id` header; the router routes them to
 *   the existing transport.
 * - All sessions see the same document. A mutation by session A is immediately visible
 *   to session B and to the browser UI (broadcast via GET /live SSE).
 * - DELETE terminates the session transport via `onsessionclosed`; the shared document
 *   is untouched.
 *
 * UI<->MCP sync (KI1-followup resolved):
 *   The shared document is the single source of truth for all MCP sessions.
 *   After every mutating `tools/call`, `setLiveDoc(result.document)` stores the new
 *   state and broadcasts it over the GET /live SSE endpoint, which the browser
 *   EventSource subscribes to for live updates.
 */

import { randomUUID } from 'node:crypto';
import { type Request, type Response, type Router, Router as createRouter } from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolResult,
  type GetPromptResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildMcpTools,
  shapeToolCallContent,
  listMcpResources,
  readMcpResource,
  listMcpPrompts,
  getMcpPrompt,
} from '@core/mcp';
import type { CadDocument } from '@core/model/types';
import { getLiveDoc } from './liveDocument';
import { applyCommand } from './commandBus';
import { buildImageBlock } from './renderImage';

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Epoch-ms of the last request routed to this session. Updated on every hit. */
  lastSeenMs: number;
}

/**
 * Live session map: session id → entry.
 * Created on MCP `initialize`; removed by any of three paths:
 *   1. HTTP DELETE  → SDK calls `onsessionclosed`
 *   2. Transport close (e.g. SDK-level cleanup) → `transport.onclose`
 *   3. Idle TTL sweep → `startSessionSweep` evicts entries not seen within TTL
 * The session's document is held in a closure inside the Server's handlers.
 */
const sessions = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// Idle-TTL sweep
// ---------------------------------------------------------------------------

/**
 * Default TTL / sweep interval (overridden by env vars).
 *
 * `MCP_SESSION_TTL_MS`   — max idle time before a session is evicted (default 30 min).
 * `MCP_SESSION_SWEEP_MS` — how often the sweep runs (default 60 s).
 *
 * Idle-TTL eviction is the catch-all for HTTP clients that abandon a session
 * without sending DELETE and without triggering a transport close event.
 * Active sessions are never evicted — every routed request touches `lastSeenMs`.
 */
const DEFAULT_TTL_MS = 30 * 60_000;   // 30 min
const DEFAULT_SWEEP_MS = 60_000;       // 60 s

function parsePosInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Start the background sweep.  The timer is `.unref()`'d so it never blocks
 * process exit.  Call once from `buildMcpRouter` — the singleton pattern
 * ensures only one sweep runs per process even if the router is rebuilt.
 */
let sweepStarted = false;

function startSessionSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;

  const ttlMs = parsePosInt(process.env['MCP_SESSION_TTL_MS'], DEFAULT_TTL_MS);
  const sweepMs = parsePosInt(process.env['MCP_SESSION_SWEEP_MS'], DEFAULT_SWEEP_MS);

  console.warn(
    `[mcp] session sweep started — TTL ${ttlMs} ms, sweep every ${sweepMs} ms`,
  );

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeenMs >= ttlMs) {
        console.warn(`[mcp] evicting idle session ${id} (idle ${now - entry.lastSeenMs} ms)`);
        sessions.delete(id);
        // Best-effort close; ignore errors (transport may already be gone).
        entry.transport.close().catch(() => {});
      }
    }
  }, sweepMs);

  // Do not keep the process alive just for housekeeping.
  timer.unref();
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * Bearer-token auth guard.
 *
 * If `MCP_AUTH_TOKEN` is set: require `Authorization: Bearer <token>`.
 * If unset: warn once at startup and allow all traffic (local dev only).
 * Never logs the token value.
 */
function buildAuthMiddleware(): (req: Request, res: Response, next: () => void) => void {
  const token = process.env['MCP_AUTH_TOKEN'];
  if (!token) {
    console.warn(
      '[warn] MCP_AUTH_TOKEN is not set — /mcp endpoint is unprotected. Set it in production.',
    );
    return (_req, _res, next) => next();
  }
  const expected = `Bearer ${token}`;
  return (req: Request, res: Response, next: () => void) => {
    if (req.headers['authorization'] !== expected) {
      res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Defaults: 60 requests per minute per IP.
 * Override via `MCP_RATE_LIMIT_MAX` (requests) and `MCP_RATE_LIMIT_WINDOW_MS`.
 */
function buildRateLimiter(): ReturnType<typeof rateLimit> {
  const windowMs = process.env['MCP_RATE_LIMIT_WINDOW_MS']
    ? parseInt(process.env['MCP_RATE_LIMIT_WINDOW_MS'], 10)
    : 60_000;
  const max = process.env['MCP_RATE_LIMIT_MAX']
    ? parseInt(process.env['MCP_RATE_LIMIT_MAX'], 10)
    : 60;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
  });
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

/**
 * Build a `Server` instance whose handlers are bound to the provided document
 * accessor functions.
 *
 * All sessions share the single live document from `liveDocument.ts`.
 * Mutations route through `commandBus.applyCommand` so every tools/call shares
 * the same undo/redo history as REST /command calls from the browser UI.
 *
 * @param getDoc - returns the current document (used for resources/read)
 */
function buildMcpServer(getDoc: () => CadDocument): Server {
  const server = new Server(
    { name: 'llull', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // tools/list — return the full registry as MCP tool definitions
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = buildMcpTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as {
        type: 'object';
        properties?: Record<string, object>;
        required?: string[];
      },
    }));
    return { tools };
  });

  // tools/call — route through commandBus so MCP edits share history + broadcast,
  // then shape the result into MCP content blocks via the single implementation
  // in core/mcp (shapeToolCallContent).  execute() runs exactly once (in the bus).
  server.setRequestHandler(CallToolRequestSchema, (req): CallToolResult => {
    const { name, arguments: args } = req.params;

    // Route through the command bus — runs execute() once, records history for
    // mutations, and broadcasts via setLiveDoc.  Query commands are skipped from
    // history/broadcast (result.data !== undefined, same logic as the UI store).
    const busResult = applyCommand(name, args ?? {});

    // Delegate all content-block assembly to the single shaping function.
    // Cast: McpShapedResult lacks the SDK Result index signature ([x: string]: unknown)
    // which is a type-system artifact — the runtime shape satisfies CallToolResult.
    const shaped = shapeToolCallContent(busResult) as CallToolResult;

    // Vision loop: if the command result carries an SVG string (data.svg), rasterize
    // it to PNG and append an image content block.  Triggered generically on any
    // command that emits data.svg — not tied to a specific command name.
    // Failure is silent (buildImageBlock returns null) so a broken SVG never 500s
    // the tool call; the text/structured content is always returned intact.
    const imageBlock = buildImageBlock(busResult.data);
    if (imageBlock !== null) {
      // Cast: the SDK's content array type is TextContent|ImageContent|EmbeddedResource
      // but the TypeScript union is exhaustive at compile time; at runtime the MCP
      // spec accepts any object with a valid `type` field. The cast is equivalent to
      // what shapeToolCallContent already does for the whole return value above.
      (shaped.content as unknown[]).push(imageBlock);
    }

    return shaped;
  });

  // resources/list — enumerate the three read-only CAD resources
  server.setRequestHandler(ListResourcesRequestSchema, () => {
    return { resources: listMcpResources() };
  });

  // resources/read — return the requested resource's current content
  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const { uri } = req.params;
    const content = readMcpResource(getDoc(), uri);
    if (content === null) {
      throw new Error(`Unknown resource URI: ${uri}`);
    }
    return { contents: [content] };
  });

  // prompts/list — enumerate registered prompt templates
  server.setRequestHandler(ListPromptsRequestSchema, () => {
    return { prompts: listMcpPrompts() };
  });

  // prompts/get — resolve a prompt template by name, substituting provided args
  server.setRequestHandler(GetPromptRequestSchema, (req): GetPromptResult => {
    const { name, arguments: rawArgs } = req.params;
    const args: Record<string, string> = {};
    if (rawArgs && typeof rawArgs === 'object') {
      for (const [k, v] of Object.entries(rawArgs)) {
        if (typeof v === 'string') args[k] = v;
      }
    }
    const result = getMcpPrompt(name, args);
    if (result === null) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    // McpPromptResult is structurally identical to GetPromptResult (description? + messages[])
    // but lacks the index signature from the SDK's Result base type.
    return result as GetPromptResult;
  });

  return server;
}

// ---------------------------------------------------------------------------
// Session initialisation
// ---------------------------------------------------------------------------

/**
 * Allocate a new MCP session bound to the shared live document.
 *
 * Returns a `{ transport, server }` pair ready to be connected and used for the
 * first `initialize` POST.  The transport's `onsessioninitialized` callback fires
 * once the SDK assigns the session id (during `handleRequest`), at which point
 * the pair is registered in `sessions`.
 *
 * Document access: all sessions share the single live document from `liveDocument.ts`.
 * `getLiveDoc` / `setLiveDoc` are passed as the accessor pair so `buildMcpServer`
 * is unchanged and testable in isolation. Mutations are broadcast to SSE subscribers
 * inside `setLiveDoc`.
 *
 * Cleanup paths (belt-and-suspenders):
 * - `onsessionclosed` fires on explicit HTTP DELETE → removes from `sessions`.
 * - `transport.onclose` fires when the underlying transport closes by ANY path
 *   (client `close()`, dropped socket, crash) → also removes from `sessions`,
 *   preventing unbounded Map growth from clients that never send DELETE.
 */
function allocateSession(): { transport: StreamableHTTPServerTransport; server: Server } {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),

    onsessioninitialized: (sessionId: string): void => {
      sessions.set(sessionId, { transport, lastSeenMs: Date.now() });
    },

    onsessionclosed: (sessionId: string): void => {
      sessions.delete(sessionId);
    },
  });

  // Belt-and-suspenders: also clean up when the transport closes via any path
  // (client disconnect, dropped socket, crash) not covered by onsessionclosed/DELETE.
  // Chain so we don't clobber any handler the SDK may have already set.
  const priorOnClose = transport.onclose;
  transport.onclose = (): void => {
    priorOnClose?.();
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  // Wire the shared live document read accessor.
  // Mutations route through commandBus.applyCommand (not setLiveDoc directly).
  const server = buildMcpServer(getLiveDoc);

  return { transport, server };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Build and return the Express Router that mounts the MCP endpoint.
 *
 * Mount in `index.ts` with:
 *   `app.use('/mcp', buildMcpRouter());`
 *
 * Exposed routes:
 *   POST   /mcp  — MCP Streamable HTTP (initialize + tools/list + tools/call)
 *   GET    /mcp  — SSE stream for server-initiated notifications (MCP spec)
 *   DELETE /mcp  — close session, free its document
 *
 * Session lifecycle:
 *   1. POST without `mcp-session-id` → new session (new UUID + empty document).
 *   2. POST/GET with `mcp-session-id` → route to existing session's transport.
 *   3. DELETE with `mcp-session-id` → SDK calls onsessionclosed → session removed.
 *   4. GET/DELETE without `mcp-session-id` header → 400 (header required).
 *   5. Any request with an unknown session id → 404.
 */
export function buildMcpRouter(): Router {
  // Start the background idle-TTL sweep (no-op if already running).
  startSessionSweep();

  const router = createRouter();
  const auth = buildAuthMiddleware();
  const limiter = buildRateLimiter();

  // Apply auth + rate limit to all MCP routes
  router.use(auth);
  router.use(limiter);

  /**
   * Route a request to an existing session's transport.
   * Returns `true` if the session id header was present (response may be an error).
   * Returns `false` if no session id header — caller handles as a new-session request.
   */
  const routeToExistingSession = async (
    req: Request,
    res: Response,
  ): Promise<boolean> => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') return false;

    const entry = sessions.get(sessionId);
    if (!entry) {
      res.status(404).json({ error: `Unknown or expired session: ${sessionId}` });
      return true; // handled (with error response)
    }

    // Touch the session so the idle-TTL sweep never evicts an active session.
    entry.lastSeenMs = Date.now();

    try {
      await entry.transport.handleRequest(req, res, req.body as unknown);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown MCP error';
      console.error(`[/mcp] session ${sessionId} error:`, msg);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP internal error.' });
      }
    }
    return true;
  };

  /**
   * POST handler:
   * - If `mcp-session-id` is present → route to existing session.
   * - Otherwise → allocate a new session (the `initialize` handshake).
   */
  router.post('/', (req: Request, res: Response) => {
    void (async () => {
      // Route to existing session if session id header is present.
      const handled = await routeToExistingSession(req, res);
      if (handled) return;

      // No session id → this is an `initialize` request; allocate a new session.
      const { transport, server } = allocateSession();

      try {
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, req.body as unknown);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown MCP error';
        console.error('[/mcp] new session error:', msg);
        // Release the connected transport/server to avoid an orphaned SSE stream
        // or Server instance when initialization fails mid-flight.
        await transport.close().catch(() => {});
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP internal error.' });
        }
      }
    })();
  });

  /**
   * GET handler — SSE stream for server-initiated notifications.
   * Requires an existing session id (SSE is only valid for live sessions).
   */
  router.get('/', (req: Request, res: Response) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId !== 'string') {
        res.status(400).json({ error: 'mcp-session-id header required for GET.' });
        return;
      }
      await routeToExistingSession(req, res);
    })();
  });

  /**
   * DELETE handler — close session and free its document.
   * The SDK's handleDeleteRequest calls onsessionclosed → removes from sessions map.
   */
  router.delete('/', (req: Request, res: Response) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId !== 'string') {
        res.status(400).json({ error: 'mcp-session-id header required for DELETE.' });
        return;
      }
      await routeToExistingSession(req, res);
    })();
  });

  return router;
}
