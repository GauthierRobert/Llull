/**
 * @layer desktop
 * Electron main process — wiring only. The app is the unchanged web app served by the unchanged
 * llull server, running locally in a utility process with a per-launch token; files, menus and
 * the CLI hand-off live in the Electron-free modules next to this file (tested without Electron).
 */

import { app, BrowserWindow, dialog, Menu, shell, utilityProcess } from 'electron';
import { randomBytes } from 'crypto';
import path from 'path';
import { errorMessage } from '@lib/errorMessage';
import { llullHome, removeDesktopDiscovery, writeDesktopDiscovery } from '@server/cli/desktopDiscovery';
import { chooseBackendPort, startBackend, type RunningBackend } from './backend';
import { backendEnv, backendOrigin } from './backendEnv';
import { cliShimFor, installCliShim } from './cliShim';
import { createDocumentSession, type DocumentSession } from './documents';
import { DEFAULT_SAVE_NAME, DOCUMENT_EXTENSIONS, DOCUMENT_FILE_PATTERN } from '@mcp/documentFiles';
import { desktopLayout } from './layout';
import { agentHelpText, menuTemplate } from './menu';
import { navigationDecision } from './navigation';

const FILE_FILTERS = [
  { name: 'llull document', extensions: [...DOCUMENT_EXTENSIONS] },
  { name: 'All files', extensions: ['*'] },
];

const layout = desktopLayout({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: path.resolve(__dirname, '..', '..'),
  platform: process.platform,
  pythonOverride: process.env['LLULL_PYTHON'],
});
const home = llullHome();
const token = randomBytes(24).toString('hex');

let backend: RunningBackend | null = null;
let session: DocumentSession | null = null;
let window: BrowserWindow | null = null;
let quitting = false;
let cliInstalled = false;
/** A file passed on the command line / opened from the OS before the window existed. */
let pendingOpen: string | null = documentArgument(process.argv);

function documentArgument(argv: readonly string[]): string | null {
  const candidate = argv.slice(app.isPackaged ? 1 : 2).find((arg) => !arg.startsWith('-'));
  return candidate !== undefined && DOCUMENT_FILE_PATTERN.test(candidate) ? candidate : null;
}

function refreshTitleAndDiscovery(): void {
  if (backend === null || session === null) return;
  const current = session.currentPath();
  window?.setTitle(`${current !== null ? path.basename(current) : 'Untitled'} — llull`);
  try {
    writeDesktopDiscovery(home, {
      url: backend.url,
      token,
      pid: process.pid,
      documentPath: current,
      version: app.getVersion(),
    });
  } catch (error) {
    // The CLI hand-off is best effort: it must never turn a successful Open/Save into an error.
    console.warn(`[llull-desktop] cannot write ${home}/desktop.json: ${errorMessage(error)}`);
  }
}

async function guarded(action: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    refreshTitleAndDiscovery();
  } catch (error) {
    dialog.showErrorBox(`llull — ${action} failed`, errorMessage(error));
  }
}

/** Ask to save unsaved changes. Resolves false when the user cancels. */
async function confirmDiscard(): Promise<boolean> {
  if (session === null || !(await session.hasUnsavedChanges())) return true;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Save changes to this document?',
  });
  if (response === 2) return false;
  if (response === 0) return saveDocument(false);
  return true;
}

/** Unsaved-changes check for quitting; a backend that cannot answer must never trap the user. */
async function confirmQuit(): Promise<boolean> {
  try {
    return await confirmDiscard();
  } catch (error) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'llull cannot check for unsaved changes.',
      detail: `${errorMessage(error)}\nThe last state is in the autosave (File > Open Data Folder).`,
    });
    return response === 0;
  }
}

let confirmingQuit = false;

/** The one quit path (window close, menu Quit, Cmd+Q): confirm, then quit for real. */
function requestQuit(): void {
  if (confirmingQuit) return;
  confirmingQuit = true;
  void confirmQuit().then((proceed) => {
    confirmingQuit = false;
    if (!proceed) return;
    quitting = true;
    app.quit();
  });
}

async function saveDocument(forceDialog: boolean): Promise<boolean> {
  if (session === null) return false;
  let target = forceDialog ? null : session.currentPath();
  if (target === null) {
    const result = await dialog.showSaveDialog({
      defaultPath: DEFAULT_SAVE_NAME,
      filters: FILE_FILTERS,
    });
    if (result.canceled || result.filePath === undefined) return false;
    target = result.filePath;
  }
  const chosen = target;
  let ok = false;
  await guarded('Save', async () => {
    const saved = await session?.save(chosen);
    if (saved !== undefined) app.addRecentDocument(saved);
    ok = true;
  });
  return ok;
}

async function openDocument(filePath?: string): Promise<void> {
  if (session === null) {
    pendingOpen = filePath ?? null;
    return;
  }
  if (!(await confirmDiscard())) return;
  let target = filePath;
  if (target === undefined) {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: FILE_FILTERS });
    target = result.canceled ? undefined : result.filePaths[0];
  }
  if (target === undefined) return;
  const chosen = target;
  await guarded('Open', async () => {
    await session?.open(chosen);
    app.addRecentDocument(chosen);
  });
}

async function newDocument(): Promise<void> {
  if (!(await confirmDiscard())) return;
  await guarded('New', async () => session?.newDocument());
}

function installCli(): void {
  const shim = cliShimFor(process.platform, process.execPath, layout.cliEntry);
  try {
    const installed = installCliShim(path.join(home, 'bin'), shim, process.platform, process.env['PATH']);
    cliInstalled = true;
    void dialog.showMessageBox({
      type: 'info',
      message: 'The llull command is installed.',
      detail: [
        `Installed ${installed.path}.`,
        installed.onPath ? 'It is already on your PATH.' : installed.pathHint,
        '',
        'With this window open, `llull --app …` acts on its document (Help > Use with Claude Code).',
      ].join('\n'),
    });
  } catch (error) {
    dialog.showErrorBox('llull — Install Command Line Tool failed', errorMessage(error));
  }
}

function createWindow(url: string): BrowserWindow {
  const created = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'llull',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const origin = new URL(url).origin;
  created.webContents.setWindowOpenHandler(({ url: target }) => {
    const decision = navigationDecision(target, origin);
    if (decision === 'external') void shell.openExternal(target);
    return { action: decision === 'app' ? 'allow' : 'deny' };
  });
  created.webContents.on('will-navigate', (event, target) => {
    if (navigationDecision(target, origin) !== 'app') event.preventDefault();
  });
  created.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    requestQuit();
  });
  void created.loadURL(`${url}/#token=${token}`);
  return created;
}

async function boot(): Promise<void> {
  const userData = app.getPath('userData');
  const port = await chooseBackendPort(userData);
  const url = backendOrigin(port);
  backend = await startBackend(
    (entry, env) => utilityProcess.fork(entry, [], { env, serviceName: 'llull-backend', stdio: 'inherit' }),
    layout.serverEntry,
    backendEnv({ port, token, layout, userDataDir: userData, baseEnv: process.env }),
    url,
  );
  session = createDocumentSession({ url, token });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(
        {
          newDocument: () => void newDocument(),
          open: () => void openDocument(),
          save: () => void saveDocument(false),
          saveAs: () => void saveDocument(true),
          installCli,
          showAgentHelp: () =>
            void dialog.showMessageBox({
              type: 'info',
              message: 'Use llull with Claude Code',
              detail: agentHelpText(cliInstalled),
            }),
          openDataFolder: () => void shell.openPath(userData),
        },
        process.platform,
        app.getName(),
      ),
    ),
  );
  window = createWindow(url);
  refreshTitleAndDiscovery();
  if (pendingOpen !== null) {
    const initial = pendingOpen;
    pendingOpen = null;
    await openDocument(initial);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    window?.show();
    window?.focus();
    const file = documentArgument(argv);
    if (file !== null) void openDocument(file);
  });
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    void openDocument(filePath);
  });
  app.on('window-all-closed', () => app.quit());
  // Menu Quit / Cmd+Q / OS shutdown: ask about unsaved changes before any window closes.
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    requestQuit();
  });
  app.on('will-quit', (event) => {
    if (backend === null) return;
    event.preventDefault();
    const stopping = backend;
    backend = null;
    removeDesktopDiscovery(home, process.pid);
    void stopping.stop().finally(() => app.quit());
  });
  void app.whenReady().then(() =>
    boot().catch((error: unknown) => {
      dialog.showErrorBox('llull could not start', errorMessage(error));
      app.exit(1);
    }),
  );
}
