/**
 * A-10 with the real server bundle, started the way the app starts it: the backend process is killed, the supervisor starts it again
 * (same port and token, `child_process.fork` like the first: not detached) and the document comes back from its recovery slot.
 */

import { fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestJson } from '@server/restClient';
import { backendEnv, backendOrigin } from '../src/backendEnv';
import { type SupervisedBackend, superviseBackend, type BackendState } from '../src/backendSupervisor';
import { desktopLayout } from '../src/layout';

const repoRoot = path.resolve(__dirname, '..', '..');
const work = mkdtempSync(path.join(tmpdir(), 'llull-desktop-restart-'));
const token = 'restart-test-token-0123456789';
const port = 47_830 + (process.pid % 40);
const url = backendOrigin(port);
const userData = path.join(work, 'userData');
const layout = {
  ...desktopLayout({ packaged: false, resourcesPath: '', repoRoot, platform: process.platform }),
  webDir: path.join(work, 'web'),
  python: 'off',
};

const states: BackendState[] = [];
let backend: SupervisedBackend;
const children: (number | undefined)[] = [];

const get = async (route: string): Promise<{ body: unknown }> => ({ body: (await requestJson(`${url}${route}`, { token })).body });
const until = async (condition: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  for (let waited = 0; !(await condition()) && waited < ms; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
};

beforeAll(async () => {
  // the test runs the bundle, not the sources: a stale bundle would test old code
  const newest = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
      const full = path.join(dir, entry.name);
      return Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
    }, 0);
  if (!existsSync(layout.serverEntry) || statSync(layout.serverEntry).mtimeMs < newest(path.join(repoRoot, 'server', 'src')))
    throw new Error(`${layout.serverEntry} is missing or older than server/src: run 'npm --prefix server run bundle' first`);
  mkdirSync(layout.webDir, { recursive: true });
  writeFileSync(path.join(layout.webDir, 'index.html'), '<!doctype html><title>llull</title>');
  backend = await superviseBackend({
    fork: (entry, env) => {
      const child = fork(entry, [], { env, stdio: 'ignore' });
      children.push(child.pid);
      return child;
    },
    entry: layout.serverEntry,
    env: {
      ...backendEnv({ port, token, layout, userDataDir: userData, baseEnv: { ...process.env, TEST: undefined, VITEST: undefined } }),
      LLULL_KERNEL: 'manifold',
      LLULL_AUTOSAVE_DEBOUNCE_MS: '20',
    },
    url,
    token,
    backoffMs: () => 50,
    onState: (state) => void states.push(state),
  });
}, 90_000);

afterAll(async () => {
  await backend.stop();
});

describe('backend crash', () => {
  it('is restarted within the bound and the document is restored from its recovery slot', async () => {
    const added = await requestJson(`${url}/command`, { body: { name: 'add_box', params: { size: [3, 3, 3] } }, token });
    expect(added.status).toBe(200);
    const recovery = path.join(userData, 'recovery');
    await until(
      () => existsSync(recovery) && readdirSync(recovery).some((name) => name.startsWith('untitled-') && name.endsWith('.meta.json')),
    );
    const before = ((await get('/live/snapshot')).body as { stateHash: string }).stateHash;
    const firstPid = backend.pid;
    expect(firstPid).toBeDefined();

    process.kill(firstPid ?? 0); // the backend dies (not stop())
    await until(() => states.some((state) => state.state === 'running'));
    expect(states.map((state) => state.state)).toEqual(['restarting', 'running']);
    expect(backend.pid).not.toBe(firstPid);

    await until(async () => (await requestJson(`${url}/health`)).ok);
    const after = (await get('/live/snapshot')).body as { stateHash: string; document: { order: string[] } };
    expect(after.document.order).toHaveLength(1);
    expect(after.stateHash).toBe(before);
    expect(children).toHaveLength(2); // two children of this process, none detached
  }, 60_000);
});
