/**
 * @layer server/tests
 * The CLI ⇄ desktop app hand-off: the discovery file (~/.llull/desktop.json) and `--app` / `status`.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  desktopDiscoveryPath,
  llullHome,
  readDesktopDiscovery,
  removeDesktopDiscovery,
  writeDesktopDiscovery,
} from '../src/cli/desktopDiscovery';
import { EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';

const newHome = (): string => mkdtempSync(path.join(tmpdir(), 'llull-home-'));
const app = {
  url: 'http://127.0.0.1:47827',
  token: 'launch-token',
  pid: process.pid,
  documentPath: null,
  version: '0.1.0',
};

function capture(env: Record<string, string>): {
  io: CliIo;
  out: string[];
  err: string[];
  calls: { url: string; auth: string | null }[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; auth: string | null }[] = [];
  return {
    out,
    err,
    calls,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(''),
      env,
      prepareKernel: () => Promise.resolve(),
      fetchImpl: (url, init) => {
        calls.push({ url, auth: new Headers(init.headers).get('Authorization') });
        return Promise.resolve(
          new Response(
            JSON.stringify({ summary: 'ok', affected: [], isError: false, changed: true }),
          ),
        );
      },
    },
  };
}

describe('desktop discovery file', () => {
  it('round-trips, is owner-only, and is removed only by its own process', () => {
    const home = newHome();
    writeDesktopDiscovery(home, app);
    expect(readDesktopDiscovery(home)).toEqual(app);
    if (process.platform !== 'win32')
      expect(statSync(desktopDiscoveryPath(home)).mode & 0o077).toBe(0);
    removeDesktopDiscovery(home, process.pid + 1);
    expect(existsSync(desktopDiscoveryPath(home))).toBe(true);
    removeDesktopDiscovery(home, process.pid);
    expect(readDesktopDiscovery(home)).toBeNull();
  });

  it('treats a file left by a dead process, or a malformed one, as no app', () => {
    const home = newHome();
    writeDesktopDiscovery(home, { ...app, pid: 2 ** 22 + 12345 });
    expect(readDesktopDiscovery(home)).toBeNull();
    writeFileSync(desktopDiscoveryPath(home), '{"url":1}');
    expect(readDesktopDiscovery(home)).toBeNull();
    writeFileSync(desktopDiscoveryPath(home), '[]');
    expect(readDesktopDiscovery(home)).toBeNull();
    writeFileSync(
      desktopDiscoveryPath(home),
      JSON.stringify({ url: 'u', token: 't', pid: process.pid }),
    );
    expect(readDesktopDiscovery(home)).toMatchObject({ documentPath: null, version: 'unknown' });
  });

  it('lives in $LLULL_HOME or ~/.llull', () => {
    expect(llullHome({ LLULL_HOME: '/x' })).toBe('/x');
    expect(llullHome({})).toMatch(/\.llull$/);
  });
});

describe('llull --app', () => {
  it('sends commands to the running app with its launch token', async () => {
    const home = newHome();
    writeDesktopDiscovery(home, app);
    const viaFlag = capture({ LLULL_HOME: home });
    expect(await runCli(['add_box', 'size=[1,1,1]', '--app'], viaFlag.io)).toBe(EXIT_OK);
    expect(viaFlag.calls[0]).toEqual({ url: `${app.url}/command`, auth: 'Bearer launch-token' });

    // $LLULL_TOKEN is a --server token (often cloud): --app keeps the launch token unless --token.
    const viaEnv = capture({ LLULL_HOME: home, LLULL_SERVER: 'app', LLULL_TOKEN: 'cloud' });
    await runCli(['undo'], viaEnv.io);
    expect(viaEnv.calls[0]).toEqual({ url: `${app.url}/undo`, auth: 'Bearer launch-token' });
    const viaFlagToken = capture({ LLULL_HOME: home });
    await runCli(['redo', '--app', '--token', 'override'], viaFlagToken.io);
    expect(viaFlagToken.calls[0]).toEqual({ url: `${app.url}/redo`, auth: 'Bearer override' });
  });

  it('fails clearly when the app is not running, and refuses new / --dry-run', async () => {
    const none = capture({ LLULL_HOME: newHome() });
    expect(await runCli(['add_box', 'size=[1,1,1]', '--app'], none.io)).toBe(EXIT_USAGE);
    expect(none.err[0]).toMatch(/desktop app is not running/);
    expect(none.calls).toEqual([]);

    const home = newHome();
    writeDesktopDiscovery(home, app);
    expect(await runCli(['new', '--app'], capture({ LLULL_HOME: home }).io)).toBe(EXIT_USAGE);
    expect(await runCli(['add_box', '--app', '--dry-run'], capture({ LLULL_HOME: home }).io)).toBe(
      EXIT_USAGE,
    );
  });
});

describe('llull status', () => {
  it('reports an app whose backend does not answer /health as not running', async () => {
    const home = newHome();
    writeDesktopDiscovery(home, app);
    const c = capture({ LLULL_HOME: home });
    const io: CliIo = { ...c.io, fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) };
    await runCli(['status'], io);
    expect(c.out[0]).toMatch(/^Desktop app: not running\./);
  });

  it('reports the running app and the local document fallback', async () => {
    const home = newHome();
    const doc = path.join(home, 'part.llull');
    const before = capture({ LLULL_HOME: home, LLULL_DOC: doc });
    await runCli(['status'], before.io);
    expect(before.out[0]).toMatch(
      /Desktop app: not running\.\nLocal document: .*part\.llull \(not created yet\)\./,
    );

    writeDesktopDiscovery(home, { ...app, documentPath: '/plans/bracket.llull' });
    writeFileSync(doc, '{}');
    const after = capture({ LLULL_HOME: home, LLULL_DOC: doc });
    await runCli(['status'], after.io);
    expect(after.out[0]).toMatch(
      /running at http:\/\/127\.0\.0\.1:47827 .*bracket\.llull — use --app/,
    );

    const json = capture({ LLULL_HOME: home, LLULL_DOC: doc });
    await runCli(['status', '--json'], json.io);
    expect(JSON.parse(json.out[0] ?? '')).toEqual({
      app: { url: app.url, pid: app.pid, documentPath: '/plans/bracket.llull', version: '0.1.0' },
      doc,
      docExists: true,
    });
  });
});
