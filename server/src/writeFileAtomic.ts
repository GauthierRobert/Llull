/**
 * Crash-safe file replacement shared by the autosaver, the CLI, desktop discovery and the desktop
 * app: the one atomic writer.
 */

import fs from 'fs';

/**
 * Write `text` to a sibling temp file, then rename it over `filePath` (atomic on POSIX). The temp
 * file is removed when the write fails; the error propagates.
 */
export function writeFileAtomic(filePath: string, text: string, mode?: number): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
