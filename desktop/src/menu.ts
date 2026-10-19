/**
 * The application menu as data: File (New / Open / Save / Save As), Edit and View roles, and Help
 * (Install Command Line Tool, Claude Code instructions, Crash Reports). Handlers are injected; no Electron calls.
 */

import type { MenuItemConstructorOptions } from 'electron';

export interface MenuHandlers {
  readonly newDocument: () => void;
  readonly open: () => void;
  readonly save: () => void;
  readonly saveAs: () => void;
  readonly installCli: () => void;
  readonly showAgentHelp: () => void;
  readonly openDataFolder: () => void;
  readonly showCrashReports: () => void;
}

export function menuTemplate(handlers: MenuHandlers, platform: NodeJS.Platform, appName: string): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: handlers.newDocument },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: handlers.open },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: handlers.save },
      { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: handlers.saveAs },
      { type: 'separator' },
      { label: 'Open Data Folder', click: handlers.openDataFolder },
      ...(mac ? [] : [{ type: 'separator' } as const, { role: 'quit' } as const]),
    ],
  };
  const help: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      { label: 'Install Command Line Tool…', click: handlers.installCli },
      { label: 'Use with Claude Code…', click: handlers.showAgentHelp },
      { type: 'separator' },
      { label: 'Crash Reports…', click: handlers.showCrashReports },
    ],
  };
  return [
    ...(mac ? [{ label: appName, role: 'appMenu' } as const] : []),
    file,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    help,
  ];
}

/** The text of Help > Use with Claude Code. */
export function agentHelpText(cliOnPath: boolean): string {
  return [
    'Drive this window from Claude Code (or any terminal) with the llull CLI:',
    '',
    '  llull status                         # is the app running?',
    '  llull search fillet edge             # find a command',
    '  llull describe fillet_edge           # its parameters',
    '  llull add_box size=[40,30,10] --app  # change the open document',
    '  llull run plan.json --validate --app # then without --validate',
    '  llull render_view --save view.png --app',
    '',
    '--app sends every command to this window (undo with Ctrl+Z or llull undo --app).',
    'Without --app the CLI works on a document file (--doc part.llull.json).',
    '',
    cliOnPath ? 'The llull command is installed.' : 'Install the llull command first: Help > Install Command Line Tool.',
  ].join('\n');
}
