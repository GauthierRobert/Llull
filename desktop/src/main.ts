/** Electron main: wiring only (unchanged server in a utility process + per-launch token); logic is in Electron-free modules. */
import { app, BrowserWindow, dialog, Menu, shell, utilityProcess } from 'electron';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { crashReportsDir } from '@server/crashReports';
import { crashReportsView, writeDesktopCrashReport } from './crashes';
import path from 'path';
import { errorMessage } from '@lib/errorMessage';
import { llullHome, removeDesktopDiscovery, writeDesktopDiscovery } from '@server/cli/desktopDiscovery';
import { chooseBackendPort, startBackend, type RunningBackend } from './backend';
import { backendEnv, backendOrigin, nativeBundleDir } from './backendEnv';
import { cliShimFor, installCliShim } from './cliShim';
import { trustPendingKeys } from './keyTrust';
import { partNumberOf, vaultCheckIn, vaultCheckOut, type VaultDeps } from './vault';
import { currentHolder } from '@server/plm/vault/vault';
import { createDocumentSession, type DocumentSession } from './documents';
import { DEFAULT_SAVE_NAME, DOCUMENT_EXTENSIONS, DOCUMENT_FILE_PATTERN } from '@protocol/documentFiles';
import { desktopLayout } from './layout';
import { agentHelpText, menuTemplate } from './menu';
import { type HidDeviceInfo, hidDevicePermitted, pickSpaceMouse } from './hid';
import { navigationDecision, permissionAllowed } from './navigation';

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
    writeDesktopDiscovery(home, { url: backend.url, token, pid: process.pid, documentPath: current, version: app.getVersion() });
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
  return response === 2 ? false : response === 0 ? saveDocument(false) : true;
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

/** The one quit path (window close, menu Quit, Cmd+Q, OS shutdown): confirm, then quit for real. */
function interceptQuit(event: { preventDefault(): void }): void {
  if (quitting) return;
  event.preventDefault();
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
    const result = await dialog.showSaveDialog({ defaultPath: DEFAULT_SAVE_NAME, filters: FILE_FILTERS });
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

/** File > Trust Signing Keys…: one native dialog per enrolled, untrusted key. The only place a key becomes trusted (keyTrust.ts). */
async function trustSigningKeys(): Promise<void> {
  try {
    const trusted = await trustPendingKeys({
      confirm: async (text) =>
        (
          await dialog.showMessageBox({
            type: 'question',
            buttons: ['Trust', 'Not now'],
            defaultId: 1,
            cancelId: 1,
            message: 'Trust signing key',
            detail: text,
          })
        ).response === 0,
    });
    await dialog.showMessageBox({
      type: 'info',
      message: trusted.length > 0 ? `Trusted ${trusted.length} signing key(s).` : 'No signing key was trusted.',
      detail: 'Enroll a key with: llull keys create --user ID --name NAME',
    });
  } catch (error) {
    dialog.showErrorBox('llull — Trust Signing Keys failed', errorMessage(error));
  }
}

/** The vault of this machine: $LLULL_VAULT, else ~/.llull/vault (created on first use). */
const configuredVault = process.env['LLULL_VAULT'];
const vaultDir = configuredVault !== undefined && configuredVault !== '' ? path.resolve(configuredVault) : path.join(home, 'vault');
const vaultHolder = currentHolder(process.env, `desktop-${randomBytes(4).toString('hex')}`);

function vaultDeps(): VaultDeps | null {
  if (session === null) return null;
  const live = session;
  return {
    dir: vaultDir,
    holder: vaultHolder,
    currentDocument: () => live.currentDocument(),
    loadDocument: (json) => live.loadDocument(json),
  };
}

/** File > Vault: Check Out…: pick the item folder in the vault, lock it, open its head. A new item is locked by its first check-in. */
async function vaultCheckOutItem(): Promise<void> {
  const deps = vaultDeps();
  if (deps === null || !(await confirmDiscard())) return;
  const result = await dialog.showOpenDialog({
    title: 'Check out an item from the vault',
    defaultPath: path.join(vaultDir, 'items'),
    properties: ['openDirectory'],
  });
  const chosen = result.canceled ? undefined : result.filePaths[0];
  if (chosen === undefined) return;
  const message = await vaultCheckOut(deps, partNumberOf(path.basename(chosen)));
  refreshTitleAndDiscovery();
  void dialog.showMessageBox({ type: 'info', message: 'Vault', detail: message });
}

/** File > Vault: Check In: the open managed item (checkpoint, snapshots to the vault, refs); the lock is freed. */
async function vaultCheckInDocument(): Promise<void> {
  const deps = vaultDeps();
  if (deps === null) return;
  const message = await vaultCheckIn(deps);
  refreshTitleAndDiscovery();
  void dialog.showMessageBox({ type: 'info', message: 'Vault', detail: message });
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

const crashDirectory = crashReportsDir(process.env);

/** Help > Crash Reports: open the folder, or the newest report's GitHub issue draft in the browser (only on this click). */
async function showCrashReports(): Promise<void> {
  const view = crashReportsView(crashDirectory);
  const buttons = view.issueUrl !== null ? ['Open Folder', 'Draft GitHub Issue…', 'Close'] : ['Open Folder', 'Close'];
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: view.message,
    detail: view.detail,
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
  });
  if (buttons[response] === 'Open Folder') {
    mkdirSync(crashDirectory, { recursive: true });
    void shell.openPath(crashDirectory);
  } else if (buttons[response] === 'Draft GitHub Issue…' && view.issueUrl !== null) void shell.openExternal(view.issueUrl);
}

/** The main process's own uncaught errors: a crash report, then a notice (the app keeps running, as Electron's default does). */
function onMainProcessError(error: unknown): void {
  const report = writeDesktopCrashReport(error, {
    directory: crashDirectory,
    autosavePath: path.join(app.getPath('userData'), 'autosave.json'),
    appVersion: app.getVersion(),
  });
  console.error('[llull-desktop] unexpected error:', error);
  try {
    dialog.showErrorBox(
      'llull hit an unexpected error',
      `${errorMessage(error)}\n\n${report !== null ? `A crash report was saved (Help > Crash Reports):\n${report}` : 'No crash report could be saved.'}`,
    );
  } catch {
    // Before the app is ready on some platforms: the report and the console line remain.
  }
}

process.on('uncaughtException', onMainProcessError);
process.on('unhandledRejection', onMainProcessError);

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
  created.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(permissionAllowed(permission, details.requestingUrl, origin)),
  );
  created.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permissionAllowed(permission, requestingOrigin, origin),
  );
  // 3D mouse: WebHID is allowed for 3Dconnexion devices only; the picker auto-selects one (no OS-style chooser needed).
  created.webContents.session.setDevicePermissionHandler((details) =>
    hidDevicePermitted({ deviceType: details.deviceType, origin: details.origin, device: details.device as HidDeviceInfo }, origin),
  );
  created.webContents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    callback(pickSpaceMouse(details.deviceList) || undefined);
  });
  created.on('close', interceptQuit);
  void created.loadURL(`${url}/#token=${token}`);
  return created;
}

async function boot(): Promise<void> {
  const userData = app.getPath('userData');
  const port = await chooseBackendPort(userData);
  const url = backendOrigin(port);
  const nativeDir = nativeBundleDir(layout.nativeDir, process.platform, existsSync);
  backend = await startBackend(
    (entry, env) => utilityProcess.fork(entry, [], { env, serviceName: 'llull-backend', stdio: 'inherit' }),
    layout.serverEntry,
    backendEnv({ port, token, layout, userDataDir: userData, baseEnv: process.env, nativeDir, vaultDir }),
    url,
    token,
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
            void dialog.showMessageBox({ type: 'info', message: 'Use llull with Claude Code', detail: agentHelpText(cliInstalled) }),
          openDataFolder: () => void shell.openPath(userData),
          trustKeys: () => void trustSigningKeys(),
          vaultCheckOut: () => void vaultCheckOutItem(),
          vaultCheckIn: () => void vaultCheckInDocument(),
          showCrashReports: () => void showCrashReports(),
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
  app.on('before-quit', interceptQuit); // before any window closes
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
