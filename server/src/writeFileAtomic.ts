/**
 * @layer server
 * Crash-safe file replacement shared by the CLI, desktop discovery and the desktop app.
 */

import fs from 'fs';

/** Write `text` to a sibling temp file, then rename it over `filePath` (atomic on POSIX). */
export function writeFileAtomic(filePath: string, text: string, mode?: number): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  fs.renameSync(temporary, filePath);
}
