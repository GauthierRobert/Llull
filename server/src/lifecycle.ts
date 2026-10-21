/** Process lifecycle: bind safely, install the geometry kernel, drain on SIGTERM/SIGINT. */

import type { Server } from 'http';
import type { Express } from 'express';
import { installGeometryKernel } from './geometryKernel';
import { installPhysicsEngine } from './physicsEngine';
import { installRasterPort } from './native/rasterPort';
import { installGeometryQueryEngine } from './native/geometryQueryEngine';
import { flushAutosave, stopAutosave, closeAllSubscribers } from './liveDocument';
import { killAllChildren } from './childProcesses';
import { checkBindSafety } from './security';
import type { CrashSource } from './crashReports';
import { reportServerCrash } from './serverCrash';

const DRAIN_TIMEOUT_MS = 5_000;

let failing = false;

/** Last words of the backend: a crash report (SC-D3), the autosave flushed, exit 1. A fault while doing so exits at once. */
function onFatalError(source: CrashSource, error: unknown): void {
  if (failing) process.exit(1);
  failing = true;
  console.error(`[llull-server] ${source}:`, error);
  const report = reportServerCrash(source, error);
  if (report !== null) console.error(`[llull-server] crash report written to ${report} (llull crashes show latest)`);
  flushAutosave();
  process.exit(1);
}

/** uncaughtException and unhandledRejection both end the process through `onFatalError`. */
export function installFatalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => onFatalError('server-uncaught-exception', error));
  process.on('unhandledRejection', (reason: unknown) => onFatalError('server-unhandled-rejection', reason));
}

const delay = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Stop accepting connections, end SSE streams, drain, flush autosave. Resolves when closed.
 * Autosave is switched to synchronous-write mode first so an edit finishing mid-drain is persisted.
 */
async function shutdown(server: Server): Promise<void> {
  stopAutosave();
  killAllChildren();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  closeAllSubscribers();
  server.closeIdleConnections();
  await Promise.race([closed, delay(DRAIN_TIMEOUT_MS)]);
  server.closeAllConnections();
  flushAutosave();
}

/**
 * Listen on host:port and install SIGTERM/SIGINT/uncaughtException/unhandledRejection handlers.
 * Resolves once the geometry kernel and physics engine are installed and the port is bound.
 * @failure non-loopback host (see `checkBindSafety`) -> rejects
 */
export async function startServer(app: Express, port: number, host: string): Promise<Server> {
  const refusal = checkBindSafety(host);
  if (refusal !== null) throw new Error(refusal);
  installRasterPort();
  installGeometryQueryEngine();
  await Promise.all([installGeometryKernel(), installPhysicsEngine()]);
  const server = app.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      console.warn(`[llull-server] listening on http://${host}:${port}`);
      resolve();
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${port} on ${host} is already in use (another llull server?). ` + 'Stop it or set PORT to a free port.')
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
  installFatalErrorHandlers();
  return server;
}
