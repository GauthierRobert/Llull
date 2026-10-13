/**
 * @layer desktop
 * "Install the `llull` command": a small launcher in `~/.llull/bin` that runs the CLI bundle
 * shipped inside the app with the app's own runtime (`ELECTRON_RUN_AS_NODE=1`), so the user and
 * Claude Code get `llull` without installing Node. With the app running, `llull --app …` drives
 * the open document (see the llull-cli skill).
 */

import fs from 'fs';
import path from 'path';

export interface CliShim {
  readonly fileName: string;
  readonly content: string;
}

/** Double-quote a path for sh (escaping the characters that stay special inside quotes). */
function shQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * The launcher script for `platform`.
 * @pure
 */
export function cliShimFor(platform: NodeJS.Platform, runtime: string, cliEntry: string): CliShim {
  if (platform === 'win32') {
    return {
      fileName: 'llull.cmd',
      content: ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${runtime}" "${cliEntry}" %*`, ''].join('\r\n'),
    };
  }
  return {
    fileName: 'llull',
    content: [
      '#!/bin/sh',
      '# llull CLI — installed by the llull desktop app (Help > Install Command Line Tool).',
      `ELECTRON_RUN_AS_NODE=1 exec ${shQuote(runtime)} ${shQuote(cliEntry)} "$@"`,
      '',
    ].join('\n'),
  };
}

export interface InstalledShim {
  readonly path: string;
  /** The shim directory is already on PATH (no shell setup needed). */
  readonly onPath: boolean;
  /** One line to add to the shell profile (or the Windows user PATH) when it is not. */
  readonly pathHint: string;
}

export function installCliShim(binDir: string, shim: CliShim, platform: NodeJS.Platform, pathVariable: string | undefined): InstalledShim {
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, shim.fileName);
  fs.writeFileSync(target, shim.content, { mode: 0o755 });
  if (platform !== 'win32') fs.chmodSync(target, 0o755);
  const separator = platform === 'win32' ? ';' : ':';
  const onPath = (pathVariable ?? '').split(separator).some((entry) => path.resolve(entry) === path.resolve(binDir));
  return {
    path: target,
    onPath,
    pathHint:
      platform === 'win32'
        ? `Add ${binDir} to your user PATH (Settings > Environment Variables).`
        : `export PATH="${binDir}:$PATH"   # add to ~/.zshrc or ~/.bashrc`,
  };
}
