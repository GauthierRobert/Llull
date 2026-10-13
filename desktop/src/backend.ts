/**
 * Lifecycle of the local backend process: pick a port (stable across launches, so the web app's
 * origin — and its localStorage preferences — stay the same), start the server bundle in its own
 * process, wait for `/health`, stop it on quit. The process launcher is injected: Electron's
 * `utilityProcess.fork` in the app, `child_process.fork` in tests.
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { isHealthy } from '@server/restClient';
import { readJsonFile } from '@server/readJsonFile';
import { writeFileAtomic } from '@server/writeFileAtomic';

/** Default local port; any free port replaces it when taken (then remembered). */
export const DEFAULT_DESKTOP_PORT = 47827;

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 150;
const STOP_TIMEOUT_MS = 8_000;

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function settingsPath(userDataDir: string): string {
  return path.join(userDataDir, 'desktop-settings.json');
}

function rememberedPort(userDataDir: string): number | null {
  const parsed = readJsonFile(settingsPath(userDataDir));
  const port = isRecord(parsed) ? parsed['port'] : undefined;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** The remembered port when free, else the default when free, else any free port (remembered). */
export async function chooseBackendPort(userDataDir: string): Promise<number> {
  const preferred = rememberedPort(userDataDir) ?? DEFAULT_DESKTOP_PORT;
  const port = (await canListen(preferred)) ? preferred : await anyFreePort();
  if (port !== rememberedPort(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    writeFileAtomic(settingsPath(userDataDir), JSON.stringify({ port }, null, 2));
  }
  return port;
}

/** The part of a child process the lifecycle needs (Electron UtilityProcess and ChildProcess both fit). */
interface BackendProcess {
  kill(): boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}

export type ForkBackend = (entry: string, env: Record<string, string>) => BackendProcess;

export interface RunningBackend {
  readonly url: string;
  /** Resolves once the process has exited (it is killed after a grace period). */
  stop(): Promise<void>;
}

async function waitForHealth(url: string, exited: () => string | null): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    const exitReason = exited();
    if (exitReason !== null) throw new Error(exitReason);
    if (await isHealthy(url)) return;
    if (Date.now() > deadline) throw new Error(`the local backend did not answer ${url}/health within ${HEALTH_TIMEOUT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
}

/**
 * Start the backend and resolve once `/health` answers.
 * @failure the process exits or never answers -> rejects (the process is killed)
 */
export async function startBackend(fork: ForkBackend, entry: string, env: Record<string, string>, url: string): Promise<RunningBackend> {
  if (!fs.existsSync(entry)) throw new Error(`backend bundle missing: ${entry} (run npm run build in desktop/)`);
  const child = fork(entry, env);
  let exitReason: string | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      exitReason = `the local backend exited (code ${String(code)})`;
      resolve();
    });
  });
  try {
    await waitForHealth(url, () => exitReason);
  } catch (error) {
    child.kill();
    throw new Error(errorMessage(error), { cause: error });
  }
  return {
    url,
    stop: async () => {
      if (exitReason !== null) return;
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))]);
    },
  };
}
