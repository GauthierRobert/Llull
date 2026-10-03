/**
 * @layer server
 *
 * Debounced, atomic autosave writer. Transport/state glue only (architecture L6).
 *
 * - `schedule(doc)` coalesces bursts of mutations into one write after `debounceMs`.
 * - Writes go to `<path>.tmp-<pid>` then `rename` (atomic on POSIX) so a crash never leaves a
 *   truncated autosave.
 * - `flush()` writes any pending document synchronously (call on shutdown).
 */

import fs from 'fs';
import path from 'path';
import type { CadDocument } from '@core/model/types';

interface Autosaver {
  schedule(doc: CadDocument): void;
  flush(): void;
  /** Flush, then make every later `schedule` write synchronously (shutdown path). */
  stop(): void;
}

interface AutosaverOptions {
  filePath: string;
  debounceMs: number;
  serialize: (doc: CadDocument) => string;
}

export function createAutosaver(options: AutosaverOptions): Autosaver {
  const { filePath, debounceMs, serialize } = options;
  let pending: CadDocument | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const writeAtomic = (doc: CadDocument): void => {
    const tempPath = `${filePath}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, serialize(doc), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      console.warn(`[autosave] write failed: ${(err as Error).message}`);
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // best effort
      }
    }
  };

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return;
    const doc = pending;
    pending = null;
    writeAtomic(doc);
  };

  return {
    schedule(doc: CadDocument): void {
      pending = doc;
      if (stopped) {
        flush();
        return;
      }
      if (timer !== null) return;
      timer = setTimeout(flush, debounceMs);
      timer.unref();
    },
    flush,
    stop(): void {
      stopped = true;
      flush();
    },
  };
}
