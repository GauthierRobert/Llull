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
 * Session model (v2 — stateful, per-session documents):
 * - Each MCP `initialize` handshake (POST without `mcp-session-id`) creates a new
 *   session entry: a fresh `CadDocument`, a `StreamableHTTPServerTransport` with a
 *   UUID session id, and a bound `Server` whose handlers read/write that session's
 *   document exclusively.
 * - Subsequent requests carry the `mcp-session-id` header; the router routes them to
 *   the existing transport.  No two sessions share state.
 * - DELETE terminates the session via `onsessionclosed`, which removes the entry and
 *   frees the document.
 * - A fresh session starts from `createEmptyDocument()` — isolated from every other
 *   concurrent session.
 *
 * TODO(KI1-followup): UI<->MCP document sync
 *   Loading the browser's live document into a new MCP session (and optionally writing
 *   MCP mutations back to the UI store) requires a UI-side piece: either a shared
 *   in-memory channel (same process) or a serialise/deserialise protocol (separate
 *   server process). The design decision — same-process singleton vs. out-of-process
 *   sidecar — must be made before implementation.  Until then, each MCP session begins
 *   from an empty document, which is correct for headless/agent-only use cases.
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
  applyMcpToolCall,
  listMcpResources,
  readMcpResource,
  listMcpPrompts,
  getMcpPrompt,
} from '@core/mcp';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';

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
 * accessor functions.  The accessor pair is closured so that mutations from
 * `tools/call` are visible to subsequent `resources/read` calls within the same
 * session without any global state.
 *
 * @param getDoc - returns the session's current document
 * @param setDoc - replaces the session's document after a mutating tool call
 */
function buildMcpServer(
  getDoc: () => CadDocument,
  setDoc: (next: CadDocument) => void,
): Server {
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

  // tools/call — delegate to applyMcpToolCall, thread session document forward
  server.setRequestHandler(CallToolRequestSchema, (req): CallToolResult => {
    const { name, arguments: args } = req.params;
    const result = applyMcpToolCall(getDoc(), name, args ?? {});

    // Store the updated document back into this session's slot
    setDoc(result.document);

    // Include affected ids in a second content block when non-empty
    const content: CallToolResult['content'] = [...result.content];
    if (result.affected.length > 0) {
      content.push({
        type: 'text',
        text: `Affected entity ids: ${result.affected.join(', ')}`,
      });
    }

    // Surface structured data produced by read-only/query commands.
    // `structuredContent` carries machine-readable output; the JSON text block
    // ensures text-only clients can still read the payload (MCP spec dual-surface).
    // Mutating commands that produce no `data` are byte-identical to before.
    if (result.data !== undefined) {
      // The JSON text block is the universal surface — valid for primitives,
      // arrays, and objects alike. `structuredContent` is reserved for spec-valid
      // records (the MCP/SDK schema types it as an object), so a future query
      // command returning a primitive or array still surfaces via the text block
      // without emitting an invalid `structuredContent`.
      content.push({
        type: 'text',
        text: `\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``,
      });
      const isRecord =
        typeof result.data === 'object' &&
        result.data !== null &&
        !Array.isArray(result.data);
      return isRecord
        ? {
            content,
            isError: result.isError,
            structuredContent: result.data as Record<string, unknown>,
          }
        : { content, isError: result.isError };
    }

    return { content, isError: result.isError };
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
 * Allocate a new isolated MCP session.
 *
 * Returns a `{ transport, server }` pair ready to be connected and used for the
 * first `initialize` POST.  The transport's `onsessioninitialized` callback fires
 * once the SDK assigns the session id (during `handleRequest`), at which point
 * the pair is registered in `sessions`.
 *
 * The session's document lives in a closure shared between `getDoc`/`setDoc` and
 * is never exposed to the module scope — guaranteeing isolation.
 *
 * Cleanup paths (belt-and-suspenders):
 * - `onsessionclosed` fires on explicit HTTP DELETE → removes from `sessions`.
 * - `transport.onclose` fires when the underlying transport closes by ANY path
 *   (client `close()`, dropped socket, crash) → also removes from `sessions`,
 *   preventing unbounded Map growth from clients that never send DELETE.
 */
function allocateSession(): { transport: StreamableHTTPServerTransport; server: Server } {
  // Mutable document slot for this session.
  let sessionDoc: CadDocument = createEmptyDocument();

  const getDoc = (): CadDocument => sessionDoc;
  const setDoc = (next: CadDocument): void => {
    sessionDoc = next;
  };

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

  const server = buildMcpServer(getDoc, setDoc);

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
