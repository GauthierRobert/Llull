/**
 * Quitting the desktop app while a native mesh job runs (TECHNICAL_SPEC 07 MSH 13.8): `stop()` ends the server's whole process tree, so the detached
 * `llull-compute` does not run on for its 600 s timeout. The real server bundle, started the way the app starts it, with a job of tens of seconds.
 */

import { fork } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { icosphere, soup } from '../../tests/helpers/meshFixtures';
import { isAlive, jobPidOf, waitFor } from '../../tests/helpers/processList';
import { nativeBinaryPath } from '@server/native/nativeBinary';
import { chooseBackendPort, startBackend } from '../src/backend';
import { backendEnv, backendOrigin } from '../src/backendEnv';
import { desktopLayout } from '../src/layout';

const native = nativeBinaryPath('llull-compute') === null ? it.skip : it;
const repoRoot = path.resolve(__dirname, '..', '..');

/** Newest modification time under `dir` (recursive). */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });

describe('stopping the desktop backend', () => {
  native(
    'stop() alone ends a running llull-compute job with the server (the host watchdog is switched off, so only the tree kill can do it)',
    async () => {
      const work = mkdtempSync(path.join(tmpdir(), 'llull-desktop-stop-'));
      const layout = {
        ...desktopLayout({ packaged: false, resourcesPath: '', repoRoot, platform: process.platform }),
        webDir: path.join(work, 'web'),
        python: 'off',
      };
      // the test runs the bundle, not the sources: a stale bundle would test old code
      if (existsSync(layout.serverEntry) && statSync(layout.serverEntry).mtimeMs < newestMtime(path.join(repoRoot, 'server', 'src')))
        throw new Error(`${layout.serverEntry} is older than server/src: run 'npm --prefix desktop run build:server' first`);
      mkdirSync(layout.webDir, { recursive: true });
      writeFileSync(path.join(layout.webDir, 'index.html'), '<!doctype html><title>llull</title>');
      const userData = path.join(work, 'userData');
      const token = 'stop-test-token-0123456789';
      // its own port: the other desktop e2e file starts a backend on the remembered default at the same time
      mkdirSync(userData, { recursive: true });
      writeFileSync(path.join(userData, 'desktop-settings.json'), JSON.stringify({ port: await freePort() }));
      const port = await chooseBackendPort(userData);
      const url = backendOrigin(port);
      let serverPid: number | undefined;
      const backend = await startBackend(
        (entry, env) => {
          const child = fork(entry, [], { env, stdio: 'ignore' });
          serverPid = child.pid;
          return child;
        },
        layout.serverEntry,
        backendEnv({
          port,
          token,
          layout,
          userDataDir: userData,
          baseEnv: { ...process.env, TEST: undefined, VITEST: undefined, LLULL_TEST_NO_HOST_WATCHDOG: '1' },
        }),
        url,
      );
      const post = (name: string, params: unknown): Promise<Response> =>
        fetch(`${url}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name, params }),
        });
      const imported = (await (await post('import_mesh', { bodies: [{ positions: soup(icosphere(10, 6)) }] })).json()) as {
        affected: string[];
      };
      const running = post('quad_remesh', { id: imported.affected[0], targetQuadCount: 30000 }).catch((error: unknown) => error);
      // the job this server started, found by its parent: another lane's llull-compute is never taken
      const job = await waitFor(() => (serverPid === undefined ? undefined : jobPidOf('llull-compute', serverPid)), 60_000);
      try {
        expect(job).toBeDefined();
        await backend.stop();
        const gone = await waitFor(() => (isAlive(job as number) ? undefined : true), 5_000);
        expect(gone).toBe(true);
      } finally {
        if (job !== undefined && isAlive(job)) process.kill(job);
        await running;
      }
    },
    120_000,
  );
});
