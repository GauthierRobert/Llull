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
 * Session strategy (v1):
 * - Stateless transport (`sessionIdGenerator: undefined`) — no per-session bookkeeping.
 *   Each `tools/call` request receives the current module-level working document.
 *   This is acceptable for v1; a session-keyed Map can be added later without
 *   changing `core/mcp` or any command code.
 * - The working document starts as `createEmptyDocument()` and is updated in-place
 *   after each successful tool call.
 */

import { type Request, type Response, type Router, Router as createRouter } from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { buildMcpTools, applyMcpToolCall } from '@core/mcp';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';

// ---------------------------------------------------------------------------
// Working document (module-level, v1 stateless session)
// ---------------------------------------------------------------------------

/**
 * The single in-memory working document.
 *
 * Design choice (v1): stateless transport, one shared document for all callers.
 * An external agent that wants isolation should POST a `delete_entity` sweep or
 * start a new server process. A future v2 can key by session id (the transport
 * provides one in stateful mode).
 */
let workingDoc: CadDocument = createEmptyDocument();

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
// MCP Server
// ---------------------------------------------------------------------------

/**
 * Build one `Server` instance with handlers for `tools/list` and `tools/call`.
 *
 * A new Server + Transport pair is created **per request** in stateless mode.
 * This matches the pattern recommended by the SDK for Streamable HTTP stateless deployments.
 */
function buildMcpServer(): Server {
  const server = new Server(
    { name: 'llull', version: '0.1.0' },
    { capabilities: { tools: {} } },
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

  // tools/call — delegate to applyMcpToolCall, thread document forward
  server.setRequestHandler(CallToolRequestSchema, (req): CallToolResult => {
    const { name, arguments: args } = req.params;
    const result = applyMcpToolCall(workingDoc, name, args ?? {});

    // Thread the working document forward (stateless v1: module-level update)
    workingDoc = result.document;

    // Include affected ids in a second content block when non-empty
    const content: CallToolResult['content'] = [...result.content];
    if (result.affected.length > 0) {
      content.push({
        type: 'text',
        text: `Affected entity ids: ${result.affected.join(', ')}`,
      });
    }

    return { content, isError: result.isError };
  });

  return server;
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
 *   POST /mcp  — MCP Streamable HTTP (initialize + tools/list + tools/call)
 *   GET  /mcp  — SSE stream for server-initiated notifications (MCP spec)
 *   DELETE /mcp — close session (stateless: no-op, returns 200)
 */
export function buildMcpRouter(): Router {
  const router = createRouter();
  const auth = buildAuthMiddleware();
  const limiter = buildRateLimiter();

  // Apply auth + rate limit to all MCP routes
  router.use(auth);
  router.use(limiter);

  /**
   * Stateless mode: a new Server + Transport instance per request.
   * The SDK's StreamableHTTPServerTransport handles the JSON-RPC framing,
   * initialization handshake, and SSE if the client requests it.
   */
  const handleRequest = async (req: Request, res: Response): Promise<void> => {
    // Stateless mode: omit sessionIdGenerator entirely (exactOptionalPropertyTypes).
    // The transport's `onclose` accessor is typed `(() => void) | undefined`, which
    // clashes with Transport's optional `onclose?: () => void` under
    // exactOptionalPropertyTypes; a precise cast to Transport satisfies `connect`
    // while keeping the argument fully type-checked.
    const transport = new StreamableHTTPServerTransport();
    const server = buildMcpServer();
    try {
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, req.body as unknown);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown MCP error';
      console.error('[/mcp] error:', msg);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP internal error.' });
      }
    }
  };

  router.post('/', (req: Request, res: Response) => {
    void handleRequest(req, res);
  });

  router.get('/', (req: Request, res: Response) => {
    void handleRequest(req, res);
  });

  router.delete('/', (_req: Request, res: Response) => {
    // Stateless mode: no session to tear down
    res.status(200).json({ status: 'ok' });
  });

  return router;
}
