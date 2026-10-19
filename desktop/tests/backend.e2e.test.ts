/**
 * The desktop app minus Electron: the real server bundle started the way the app starts it
 * (backendEnv + startBackend, `child_process.fork` instead of `utilityProcess.fork`), then the
 * File menu operations (DocumentSession) and the Claude Code path (`llull --app` via the
 * discovery file) against it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { writeDesktopDiscovery } from '@server/cli/desktopDiscovery';
import { nativeBinaryPath, nativeInstallHint } from '@server/native/nativeBinary';
import { requestJson } from '@server/restClient';
import { chooseBackendPort, startBackend, type RunningBackend } from '../src/backend';
import { backendEnv, backendOrigin, nativeBundleDir } from '../src/backendEnv';
import { createDocumentSession, type DocumentSession } from '../src/documents';
import { desktopLayout } from '../src/layout';

const repoRoot = path.resolve(__dirname, '..', '..');
const work = mkdtempSync(path.join(tmpdir(), 'llull-desktop-e2e-'));
const home = path.join(work, 'home');
const token = 'test-token-0123456789';
const layout = {
  ...desktopLayout({ packaged: false, resourcesPath: '', repoRoot, platform: process.platform }),
  webDir: path.join(work, 'web'),
  python: process.env['LLULL_TEST_PYTHON'] ?? 'off',
};

let backend: RunningBackend;
let session: DocumentSession;

/** The installed `llull` command, as Claude Code runs it (local --doc runs use the same Python). */
const runCli = (...args: string[]): Promise<{ stdout: string }> =>
  promisify(execFile)(process.execPath, [layout.cliEntry, ...args], {
    env: { ...process.env, LLULL_HOME: home, LLULL_PYTHON: layout.python },
  });

const nativeKernelBinary = nativeBinaryPath('llull-kernel', { ...process.env, LLULL_NATIVE_DIR: '' });
if (nativeKernelBinary === null && process.env['LLULL_REQUIRE_NATIVE_KERNEL'] === '1') throw new Error(nativeInstallHint('llull-kernel'));

beforeAll(async () => {
  mkdirSync(layout.webDir, { recursive: true });
  writeFileSync(path.join(layout.webDir, 'index.html'), '<!doctype html><title>llull</title>');
  const userData = path.join(work, 'userData');
  const port = await chooseBackendPort(userData);
  const url = backendOrigin(port);
  backend = await startBackend(
    (entry, env) => fork(entry, [], { env, stdio: 'ignore' }),
    layout.serverEntry,
    // Vitest sets TEST/VITEST, which keep the server from listening; the app never has them.
    backendEnv({ port, token, layout, userDataDir: userData, baseEnv: { ...process.env, TEST: undefined, VITEST: undefined } }),
    url,
  );
  session = createDocumentSession({ url, token });
  writeDesktopDiscovery(home, { url, token, pid: process.pid, documentPath: null, version: 'test' });
}, 60_000);

afterAll(async () => {
  await backend.stop();
});

describe('desktop backend', () => {
  it('serves the web app on its origin and refuses REST calls without the launch token', async () => {
    const page = await fetch(`${backend.url}/`);
    expect(await page.text()).toContain('<title>llull</title>');
    const anonymous = await fetch(`${backend.url}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'add_box', params: { size: [1, 1, 1] } }),
    });
    expect(anonymous.status).toBe(401);
    const otherSite = await fetch(`${backend.url}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    expect([401, 403]).toContain(otherSite.status);
  });

  it('without a native bundle falls through to Manifold and says why (kernel_info, TR-KRN-01)', async () => {
    const info = await runCli('kernel_info', '--app', '--json');
    expect(JSON.parse(info.stdout)).toMatchObject({
      ok: true,
      data: { active: 'manifold', fallbackReason: expect.stringMatching(/^NATIVE_TOOL_MISSING/) },
    });
  }, 120_000);

  it('drives the open document from the CLI with --app, then saves it like File > Save', async () => {
    const status = await runCli('status');
    expect(status.stdout).toMatch(/Desktop app: running at http:\/\/127\.0\.0\.1:\d+/);

    await session.newDocument();
    expect(await session.hasUnsavedChanges()).toBe(false);

    const added = await runCli('add_box', 'size=[10,20,30]', '--app', '--json');
    const boxId = (JSON.parse(added.stdout) as { affected: string[] }).affected[0] ?? '';
    await runCli('set_entity_name', `id=${boxId}`, 'name=bracket', '--app');
    expect(await session.hasUnsavedChanges()).toBe(true);

    const saved = await session.save(path.join(work, 'out', 'part.llull'));
    expect(await session.hasUnsavedChanges()).toBe(false);
    const doc = deserializeDocument(readFileSync(saved, 'utf8'));
    expect(Object.values(doc.entities).map((entity) => entity.name)).toEqual(['bracket']);

    const local = await runCli('describe_scene', '--doc', saved, '--json');
    expect(JSON.parse(local.stdout)).toMatchObject({ ok: true, data: { entityCount: 1 } });
  });

  it('opens a file into the live document and starts clean', async () => {
    const file = path.join(work, 'two.llull');
    await runCli('add_sphere', 'radius=2', '--doc', file);
    await runCli('add_cone', 'radius=1', 'height=2', '--doc', file);
    await session.open(file);
    expect(session.currentPath()).toBe(file);
    expect(await session.hasUnsavedChanges()).toBe(false);
    const scene = await runCli('describe_scene', '--app', '--json');
    expect(JSON.parse(scene.stdout)).toMatchObject({ data: { entityCount: 2 } });

    await runCli('undo', '--app');
    expect(await session.hasUnsavedChanges()).toBe(true);
  });

  it('rejects an unreadable file and Save without a path', async () => {
    const broken = path.join(work, 'broken.llull');
    writeFileSync(broken, '{"not":"a document"}');
    await expect(session.open(broken)).rejects.toThrow(/load_document|invalid|format/i);
    await session.newDocument();
    await expect(session.save()).rejects.toThrow(/Save As/);
  });

  it.skipIf(process.env['LLULL_TEST_PYTHON'] === undefined)(
    'imports a STEP file into the open document with the bundled-Python path (llull import_step --app)',
    async () => {
      const part = path.join(work, 'part.llull');
      await runCli('add_box', 'size=[40,30,10]', '--doc', part);
      const step = path.join(work, 'part.step');
      await runCli('export_step', '--save', step, '--doc', part);
      await session.newDocument();
      const imported = await runCli('import_step', `file=${step}`, '--app');
      expect(imported.stdout).toMatch(/Imported 1 mesh bod/);
      expect(await session.hasUnsavedChanges()).toBe(true);
    },
    120_000,
  );
});

// The KI7 default: with the native bundle (here the local release build of llull-kernel standing in for resources/native) the app
// starts the backend on the native OCCT 7.9 kernel, exactly as src/main.ts computes it.

describe.skipIf(nativeKernelBinary === null)('desktop backend with the native bundle (KI7)', () => {
  let native: RunningBackend | undefined;

  beforeAll(async () => {
    const userData = path.join(work, 'userData-native');
    const port = await chooseBackendPort(userData);
    const nativeDir = nativeBundleDir(path.dirname(nativeKernelBinary!), process.platform, existsSync);
    native = await startBackend(
      (entry, env) => fork(entry, [], { env, stdio: 'ignore' }),
      layout.serverEntry,
      backendEnv({
        port,
        token,
        layout,
        userDataDir: userData,
        baseEnv: { ...process.env, TEST: undefined, VITEST: undefined, LLULL_KERNEL: undefined },
        nativeDir,
      }),
      backendOrigin(port),
    );
  }, 60_000);

  afterAll(async () => {
    await native?.stop();
  });

  it('runs the native OCCT 7.9 kernel in its own process (kernel_info)', async () => {
    const reply = await requestJson(`${native!.url}/command`, { token, body: { name: 'kernel_info', params: {} } });
    expect(reply.body).toMatchObject({ data: { active: 'occt', occtVersion: '7.9.2', isolation: 'process' } });
  }, 120_000);
});
