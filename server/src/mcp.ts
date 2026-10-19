/**
 * MCP Streamable HTTP endpoint: auth + rate limit + session routing (tools: `./mcp/server.ts`).
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
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type ToolsetName, parseToolsets } from '@mcp/index';
import { errorMessage } from '@lib/errorMessage';
import type { ExchangeOptions } from './pythonExchange';
import { exchangeOptionsWithDwg } from './dwgConvert';
import { evictForCapacity, sessions, startSessionSweep } from './mcp/sessions';
import { buildAuthMiddleware, buildMcpRateLimiter } from './mcp/middleware';
import { buildMcpServer } from './mcp/server';
import { isLocalPeer } from './security';

/** Toolsets from `LLULL_TOOLSETS` (comma-separated; unset = core only, `all` = everything). Warns on unknown names. */
export function toolsetsFromEnv(raw: string | undefined = process.env['LLULL_TOOLSETS']): ReadonlySet<ToolsetName> {
  const { enabled, unknown } = parseToolsets(raw);
  if (unknown.length > 0) console.warn(`[llull-mcp] LLULL_TOOLSETS: ignoring unknown toolset(s): ${unknown.join(', ')}`);
  return enabled;
}

export function buildMcpRouter(
  exchange: ExchangeOptions = exchangeOptionsWithDwg(),
  enabledToolsets: ReadonlySet<ToolsetName> = toolsetsFromEnv(),
): Router {
  startSessionSweep();
  const router = createRouter();
  router.use(buildAuthMiddleware());
  router.use(buildMcpRateLimiter());

  const allocateSession = (remote: boolean): StreamableHTTPServerTransport => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => void sessions.set(sessionId, { transport, lastSeenMs: Date.now(), remote }),
      onsessionclosed: (sessionId) => void sessions.delete(sessionId),
    });
    // Any other close path (dropped socket, crash) forgets the session too.
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
    if (entry.remote === isLocalPeer(req)) {
      res.status(403).json({ error: 'This MCP session was opened from a different network locality.' });
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
      // Anything else is rejected by the transport and must not push other sessions out.
      if (isInitializeRequest(req.body)) evictForCapacity();
      const remote = !isLocalPeer(req);
      const transport = allocateSession(remote);
      try {
        await buildMcpServer(exchange, enabledToolsets, { remote }).connect(transport as Transport);
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
