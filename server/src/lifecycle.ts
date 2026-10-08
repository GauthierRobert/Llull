/**
 * @layer server
 * Process lifecycle: bind safely, install the geometry kernel, drain on SIGTERM/SIGINT.
 */

import type { Server } from 'http';
import type { Express } from 'express';
import { installGeometryKernel } from './geometryKernel';
import { flushAutosave, stopAutosave, closeAllSubscribers } from './liveDocument';
import { closeAllSessions } from './mcp/sessions';
import { checkBindSafety, isLoopbackAddress } from './security';

const SESSION_CLOSE_TIMEOUT_MS = 3_000;
const DRAIN_TIMEOUT_MS = 5_000;

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Stop accepting connections, end SSE/MCP streams, drain, flush autosave. Resolves when closed.
 * Autosave is switched to synchronous-write mode first so an edit finishing mid-drain is persisted.
 */
async function shutdown(server: Server): Promise<void> {
  stopAutosave();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  closeAllSubscribers();
  await Promise.race([closeAllSessions(), delay(SESSION_CLOSE_TIMEOUT_MS)]);
  server.closeIdleConnections();
  await Promise.race([closed, delay(DRAIN_TIMEOUT_MS)]);
  server.closeAllConnections();
  flushAutosave();
}

/**
 * Listen on host:port and install SIGTERM/SIGINT/uncaughtException handlers.
 * Resolves once the geometry kernel is installed and the port is bound.
 * @failure unsafe bind (see `checkBindSafety`) -> rejects
 */
export async function startServer(app: Express, port: number, host: string): Promise<Server> {
  const refusal = checkBindSafety(host);
  if (refusal !== null) throw new Error(refusal);
  if (!isLoopbackAddress(host) && !process.env['MCP_AUTH_TOKEN']) {
    console.warn(
      '[llull-server] WARNING: network-exposed without MCP_AUTH_TOKEN (LLULL_ALLOW_UNAUTHENTICATED=true).',
    );
  }
  await installGeometryKernel();
  const server = app.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      console.warn(`[llull-server] listening on http://${host}:${port}`);
      resolve();
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} on ${host} is already in use (another llull server?). ` +
                'Stop it or set PORT to a free port.',
            )
          : error,
      );
    });
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
