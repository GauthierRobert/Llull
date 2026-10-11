/**
 * @layer server
 * How the `llull` CLI finds the running desktop app: the app writes `<home>/.llull/desktop.json`
 * (owner-only) when its backend is up and removes it on quit; `llull --app` reads it for the URL
 * and the per-launch bearer token. Written by `desktop/`, read by the CLI — one format, here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isRecord } from '@lib/isRecord';

export interface DesktopDiscovery {
  /** Base URL of the app's local backend, e.g. `http://127.0.0.1:47827`. */
  readonly url: string;
  /** Per-launch bearer token for `/command`, `/live/snapshot`, `/export/*`. */
  readonly token: string;
  /** Process id of the desktop app's main process (stale-file check). */
  readonly pid: number;
  /** Document file open in the app, or null for an unsaved document. */
  readonly documentPath: string | null;
  readonly version: string;
}

/** `$LLULL_HOME` (tests, portable installs) or `~/.llull`. */
export function llullHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env['LLULL_HOME'] ?? path.join(os.homedir(), '.llull');
}

export function desktopDiscoveryPath(home: string): string {
  return path.join(home, 'desktop.json');
}

/** Write the discovery file readable by the current user only. */
export function writeDesktopDiscovery(home: string, discovery: DesktopDiscovery): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = desktopDiscoveryPath(home);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(discovery, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** Remove the discovery file if it still belongs to `pid` (a newer app instance keeps its own). */
export function removeDesktopDiscovery(home: string, pid: number): void {
  const current = readDesktopDiscoveryFile(home);
  if (current !== null && current.pid !== pid) return;
  fs.rmSync(desktopDiscoveryPath(home), { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return isRecord(error) && error['code'] === 'EPERM';
  }
}

function readDesktopDiscoveryFile(home: string): DesktopDiscovery | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(desktopDiscoveryPath(home), 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { url, token, pid, documentPath, version } = parsed;
  if (typeof url !== 'string' || typeof token !== 'string' || typeof pid !== 'number') return null;
  return {
    url,
    token,
    pid,
    documentPath: typeof documentPath === 'string' ? documentPath : null,
    version: typeof version === 'string' ? version : 'unknown',
  };
}

/**
 * The running desktop app, or null when none is running (no file, unreadable, or its process is
 * gone — a crash leaves the file behind).
 */
export function readDesktopDiscovery(home: string): DesktopDiscovery | null {
  const discovery = readDesktopDiscoveryFile(home);
  return discovery !== null && isProcessAlive(discovery.pid) ? discovery : null;
}
