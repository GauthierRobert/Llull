/**
 * The archive extractor used by the packaging scripts (TR-ASC-02): the operating system's own `tar`, never the first `tar` on `PATH`
 * (on Windows a Git / MSYS `tar` on `PATH` misreads `C:\` paths and fails the extract).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Absolute path of the system `tar` for `platform`; throws when none of the known locations holds one. */
export function systemTar(platform = process.platform, env = process.env, exists = existsSync) {
  const candidates =
    platform === 'win32'
      ? [path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'tar.exe')]
      : ['/usr/bin/tar', '/bin/tar'];
  const found = candidates.find((candidate) => exists(candidate));
  if (found === undefined) throw new Error(`no system tar found (looked in ${candidates.join(', ')})`);
  return found;
}
