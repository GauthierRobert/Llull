/**
 * The export file port of this machine (05 IMP 14.12): a command that must not return its package as one string (`export_3mf` above ~8 million triangles)
 * writes it here in chunks. Files go to LLULL_EXPORT_DIR (default `<tmp>/llull-exports`) under a unique name; `--save` moves the file to its target.
 * @invariant the file is written with positioned writes (no whole-package buffer); a failed export is removed
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportFilePort, ExportFileWriter } from '@core/commands/types';

function exportDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_EXPORT_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(os.tmpdir(), 'llull-exports');
}

function writeAll(fd: number, bytes: Uint8Array, position: number): void {
  let done = 0;
  while (done < bytes.length) done += fs.writeSync(fd, bytes, done, bytes.length - done, position + done);
}

let counter = 0;

export function exportFilePort(directory: string = exportDirectory()): ExportFilePort {
  return {
    open(fileName): ExportFileWriter | null {
      try {
        fs.mkdirSync(directory, { recursive: true });
        counter += 1;
        const target = path.join(directory, `${process.pid}-${counter}-${path.basename(fileName).replace(/[^A-Za-z0-9._-]/g, '_')}`);
        const fd = fs.openSync(target, 'w');
        let position = 0;
        return {
          write(chunk) {
            writeAll(fd, chunk, position);
            position += chunk.length;
          },
          patch: (offset, bytes) => writeAll(fd, bytes, offset),
          close() {
            fs.closeSync(fd);
            return { path: target };
          },
          abort() {
            try {
              fs.closeSync(fd);
            } catch {
              // already closed
            }
            fs.rmSync(target, { force: true });
          },
        };
      } catch {
        return null;
      }
    },
  };
}
