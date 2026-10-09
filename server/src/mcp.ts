/**
 * @layer server
 * MCP endpoint — Streamable HTTP transport (auth + rate limit + session routing only; tool logic
 * is `./mcp/server.ts` over `@mcp`, architecture L6).
 *
 *   POST   /mcp  no `mcp-session-id` -> `initialize`, allocates a session; with it -> that session
 *   GET    /mcp  SSE stream for server notifications (session id required)
 *   DELETE /mcp  close the session (the shared document is untouched)
 *   unknown session id -> 404; missing header on GET/DELETE -> 400
 *
 * All sessions share the one live document (`liveDocument.ts`). A session is removed on DELETE
 * (`onsessionclosed`), on any transport close, or by the idle-TTL sweep (`mcp/sessions.ts`).
 */

import { randomUUID } from 'node:crypto';
import { type Request, type Response, type Router, Router as createRouter } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { parseToolsets } from '@mcp/index';
import { errorMessage } from '@lib/errorMessage';
import type { ToolsetName } from '@mcp/index';
import type { ExchangeOptions } from './pythonExchange';
import { exchangeOptionsWithDwg } from './dwgConvert';
import { evictForCapacity, sessions, startSessionSweep } from './mcp/sessions';
import { buildAuthMiddleware, buildMcpRateLimiter } from './mcp/middleware';
import { buildMcpServer } from './mcp/server';

/** Toolsets from `LLULL_TOOLSETS` (comma-separated; unset = core only, `all` = everything). Warns on unknown names. */
export function toolsetsFromEnv(
  raw: string | undefined = process.env['LLULL_TOOLSETS'],
): ReadonlySet<ToolsetName> {
  const { enabled, unknown } = parseToolsets(raw);
  if (unknown.length > 0) {
    console.warn(`[llull-mcp] LLULL_TOOLSETS: ignoring unknown toolset(s): ${unknown.join(', ')}`);
  }
  return enabled;
}

/**
 * @param exchange - STEP/code exchange port (defaults to the environment-configured Python bridge).
 * @param enabledToolsets - starting toolsets for each session (defaults to `LLULL_TOOLSETS`).
 */
export function buildMcpRouter(
  exchange: ExchangeOptions = exchangeOptionsWithDwg(),
  enabledToolsets: ReadonlySet<ToolsetName> = toolsetsFromEnv(),
): Router {
  startSessionSweep();
  const router = createRouter();
  router.use(buildAuthMiddleware());
  router.use(buildMcpRateLimiter());

  /** Transport + bound `Server`; the session registers itself once the SDK assigns its id. */
  const allocateSession = (): StreamableHTTPServerTransport => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, lastSeenMs: Date.now() });
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    // Also forget the session on any other close path (dropped socket, client close, crash).
    const priorOnClose = transport.onclose;
    transport.onclose = (): void => {
      priorOnClose?.();
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    return transport;
  };

  /** Route to the session named by the header; false when the header is absent. */
  const routeToExistingSession = async (req: Request, res: Response): Promise<boolean> => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') return false;
    const entry = sessions.get(sessionId);
    if (!entry) {
      res.status(404).json({ error: `Unknown or expired session: ${sessionId}` });
      return true;
    }
    entry.lastSeenMs = Date.now(); // keeps the idle sweep away from active sessions
    try {
      await entry.transport.handleRequest(req, res, req.body as unknown);
    } catch (err: unknown) {
      console.error(`[/mcp] session ${sessionId} error:`, errorMessage(err));
      if (!res.headersSent) res.status(500).json({ error: 'MCP internal error.' });
    }
    return true;
  };

  router.post('/', (req: Request, res: Response) => {
    void (async () => {
      if (await routeToExistingSession(req, res)) return;
      evictForCapacity();
      const transport = allocateSession();
      try {
        await buildMcpServer(exchange, enabledToolsets).connect(transport as Transport);
        await transport.handleRequest(req, res, req.body as unknown);
      } catch (err: unknown) {
        console.error('[/mcp] new session error:', errorMessage(err));
        await transport.close().catch(() => {}); // no orphaned stream/Server after a failed init
        if (!res.headersSent) res.status(500).json({ error: 'MCP internal error.' });
      }
    })();
  });

  const requireSession =
    (method: 'GET' | 'DELETE') =>
    (req: Request, res: Response): void => {
      void (async () => {
        if (!(await routeToExistingSession(req, res))) {
          res.status(400).json({ error: `mcp-session-id header required for ${method}.` });
        }
      })();
    };
  router.get('/', requireSession('GET'));
  router.delete('/', requireSession('DELETE'));

  return router;
}
