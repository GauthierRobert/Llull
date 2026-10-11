/**
 * @layer desktop/tests
 * Electron-free desktop modules: layout, backend env, port choice, CLI shim, menu.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chooseBackendPort, DEFAULT_DESKTOP_PORT } from '../src/backend';
import { backendEnv, backendOrigin } from '../src/backendEnv';
import { cliShimFor, installCliShim } from '../src/cliShim';
import { bundledPythonOf, desktopLayout } from '../src/layout';
import { agentHelpText, menuTemplate } from '../src/menu';
import { navigationDecision } from '../src/navigation';
import { createDocumentSession } from '../src/documents';

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'llull-desktop-'));

describe('desktopLayout', () => {
  it('reads every part from resources when packaged', () => {
    const layout = desktopLayout({
      packaged: true,
      resourcesPath: '/r',
      repoRoot: '/repo',
      platform: 'linux',
    });
    expect(layout).toEqual({
      webDir: path.join('/r', 'web'),
      serverEntry: path.join('/r', 'server', 'dist', 'index.js'),
      cliEntry: path.join('/r', 'server', 'dist', 'cli.js'),
      python: path.join('/r', 'python', 'bin', 'python3'),
    });
  });

  it('uses the repo checkout in development, with a Python override', () => {
    const layout = desktopLayout({
      packaged: false,
      resourcesPath: '/r',
      repoRoot: '/repo',
      platform: 'darwin',
      pythonOverride: '/usr/bin/python3',
    });
    expect(layout.webDir).toBe(path.join('/repo', 'dist'));
    expect(layout.python).toBe('/usr/bin/python3');
    expect(
      desktopLayout({ packaged: false, resourcesPath: '', repoRoot: '/repo', platform: 'linux' })
        .python,
    ).toBe(path.join('/repo', 'desktop', 'build', 'python', 'bin', 'python3'));
    expect(bundledPythonOf('C:\\py', 'win32')).toMatch(/python\.exe$/);
  });
});

describe('backendEnv', () => {
  it('locks the backend to loopback with a required token and the app origin', () => {
    const layout = desktopLayout({
      packaged: true,
      resourcesPath: '/r',
      repoRoot: '',
      platform: 'linux',
    });
    const env = backendEnv({
      port: 4000,
      token: 'tok',
      layout,
      userDataDir: '/u',
      baseEnv: { PATH: '/bin', LLULL_KERNEL: 'occt', MCP_AUTH_TOKEN: 'leak', EMPTY: undefined },
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      HOST: '127.0.0.1',
      PORT: '4000',
      MCP_AUTH_TOKEN: 'tok',
      LLULL_REQUIRE_TOKEN_FOR_REST: 'true',
      LLULL_ALLOWED_ORIGINS: 'http://127.0.0.1:4000',
      LLULL_STATIC_DIR: path.join('/r', 'web'),
      LLULL_AUTOSAVE_PATH: path.join('/u', 'autosave.json'),
      LLULL_PYTHON: layout.python,
    });
    expect(env['LLULL_KERNEL']).toBeUndefined();
    expect(env['LLULL_ALLOW_CODE_EXECUTION']).toBeUndefined();
    const optedIn = backendEnv({
      port: 1,
      token: 't',
      layout,
      userDataDir: '/u',
      baseEnv: { LLULL_ALLOW_CODE_EXECUTION: '1' },
    });
    expect(optedIn['LLULL_ALLOW_CODE_EXECUTION']).toBe('1');
    expect('EMPTY' in env).toBe(false);
    expect(backendOrigin(1)).toBe('http://127.0.0.1:1');
  });
});

describe('navigationDecision', () => {
  const origin = 'http://127.0.0.1:47827';

  it('keeps only the app origin in the window, sends web links to the browser', () => {
    expect(navigationDecision(`${origin}/#token=x`, origin)).toBe('app');
    expect(navigationDecision('https://docs.example.com/a', origin)).toBe('external');
    expect(navigationDecision('http://127.0.0.1:47828/', origin)).toBe('external');
  });

  it('is not fooled by userinfo or other schemes, and denies malformed URLs', () => {
    expect(navigationDecision(`${origin}@evil.example/`, origin)).toBe('external');
    expect(navigationDecision('file:///etc/passwd', origin)).toBe('deny');
    expect(navigationDecision('javascript:alert(1)', origin)).toBe('deny');
    expect(navigationDecision('not a url', origin)).toBe('deny');
  });
});

describe('createDocumentSession', () => {
  it('reports the HTTP status when the backend answers with a non-JSON page', async () => {
    const session = createDocumentSession({
      url: 'http://127.0.0.1:1',
      token: 't',
      fetchImpl: () => Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    });
    await expect(session.hasUnsavedChanges()).rejects.toThrow(/HTTP 502/);
    await expect(session.newDocument()).rejects.toThrow(/HTTP 502/);
  });
});

describe('chooseBackendPort', () => {
  it('prefers the default, remembers a replacement when it is taken', async () => {
    const userData = scratch();
    const blocker = net.createServer();
    const blocked = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false));
      blocker.listen(DEFAULT_DESKTOP_PORT, '127.0.0.1', () => resolve(true));
    });
    try {
      const port = await chooseBackendPort(userData);
      if (blocked) expect(port).not.toBe(DEFAULT_DESKTOP_PORT);
      const remembered = JSON.parse(
        readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8'),
      ) as { port: number };
      expect(remembered.port).toBe(port);
      expect(await chooseBackendPort(userData)).toBe(port);
    } finally {
      blocker.close();
    }
  });

  it('ignores an unreadable settings file', async () => {
    const userData = scratch();
    writeFileSync(path.join(userData, 'desktop-settings.json'), '{"port":"nope"}');
    expect(await chooseBackendPort(userData)).toBeGreaterThan(0);
  });
});

describe('cliShim', () => {
  it('runs the bundled CLI with the app runtime on POSIX, quoting paths', () => {
    const shim = cliShimFor(
      'darwin',
      '/Applications/llull.app/Contents/MacOS/llull',
      '/R "x"/bin.js',
    );
    expect(shim.fileName).toBe('llull');
    expect(shim.content).toContain(
      'ELECTRON_RUN_AS_NODE=1 exec "/Applications/llull.app/Contents/MacOS/llull" "/R \\"x\\"/bin.js" "$@"',
    );
  });

  it('writes a .cmd launcher on Windows', () => {
    const shim = cliShimFor('win32', 'C:\\llull\\llull.exe', 'C:\\llull\\resources\\bin.js');
    expect(shim.fileName).toBe('llull.cmd');
    expect(shim.content).toContain(
      'set ELECTRON_RUN_AS_NODE=1\r\n"C:\\llull\\llull.exe" "C:\\llull\\resources\\bin.js" %*',
    );
  });

  it('installs an executable shim and reports whether its directory is on PATH', () => {
    const bin = path.join(scratch(), 'bin');
    const shim = cliShimFor('linux', '/opt/llull/llull', '/opt/llull/bin.js');
    const off = installCliShim(bin, shim, 'linux', '/usr/bin:/bin');
    expect(statSync(off.path).mode & 0o111).not.toBe(0);
    expect(off.onPath).toBe(false);
    expect(off.pathHint).toContain(`export PATH="${bin}:$PATH"`);
    expect(installCliShim(bin, shim, 'linux', `/usr/bin:${bin}`).onPath).toBe(true);
    expect(installCliShim(bin, cliShimFor('win32', 'a', 'b'), 'win32', undefined).pathHint).toMatch(
      /user PATH/,
    );
  });
});

describe('menuTemplate', () => {
  const calls: string[] = [];
  const handler = (name: string) => (): void => {
    calls.push(name);
  };
  const handlers = {
    newDocument: handler('new'),
    open: handler('open'),
    save: handler('save'),
    saveAs: handler('saveAs'),
    installCli: handler('cli'),
    showAgentHelp: handler('help'),
    openDataFolder: handler('data'),
  };

  it('has File and Help menus wired to the handlers, an app menu only on macOS', () => {
    const linux = menuTemplate(handlers, 'linux', 'llull');
    expect(linux.map((item) => item.label ?? item.role)).toEqual([
      'File',
      'editMenu',
      'viewMenu',
      'windowMenu',
      'Help',
    ]);
    expect(menuTemplate(handlers, 'darwin', 'llull')[0]?.role).toBe('appMenu');
    const items = linux.flatMap((menu) => (Array.isArray(menu.submenu) ? menu.submenu : []));
    for (const item of items) if (typeof item.click === 'function') (item.click as () => void)();
    expect(calls).toEqual(['new', 'open', 'save', 'saveAs', 'data', 'cli', 'help']);
  });

  it('explains --app and points to the installer until the CLI is installed', () => {
    expect(agentHelpText(false)).toMatch(/--app/);
    expect(agentHelpText(false)).toMatch(/Install Command Line Tool/);
    expect(agentHelpText(true)).toMatch(/is installed/);
  });
});
