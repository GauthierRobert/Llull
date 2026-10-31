/**
 * Moving a file a host wrote (05 IMP 14.12) to the place the user chose. Kept apart from `cli/saveFiles.ts` so the desktop main process can use it without
 * bundling the SVG rasterizer.
 */

import fs from 'node:fs';

/** The file operations of a move, injectable so a failing volume or a locked target can be tested. */
export interface MoveOps {
  readonly renameSync: (from: string, to: string) => void;
  readonly copyFileSync: (from: string, to: string) => void;
  readonly rmSync: (file: string, options: { force: boolean }) => void;
}

/**
 * Moves `from` to `to`: a rename, else (another volume, a locked file) a copy to `<to>.part` that is renamed into place, so `to` never holds a partial file.
 * @failure the copy or the final rename fails -> the .part file and `from` are removed and the error is rethrown; removing `from` after a complete copy never fails the move
 */
export function moveHostedFile(from: string, to: string, ops: MoveOps = fs): void {
  try {
    ops.renameSync(from, to);
    return;
  } catch {
    // another volume or a locked target: fall through to the copy
  }
  const part = `${to}.part`;
  try {
    ops.copyFileSync(from, part);
    ops.renameSync(part, to);
  } catch (error) {
    ops.rmSync(part, { force: true });
    ops.rmSync(from, { force: true });
    throw error;
  }
  // the destination is complete: a hosted file that cannot be removed is left to the export folder's reaper, never an error
  try {
    ops.rmSync(from, { force: true });
  } catch {
    // locked or already gone
  }
}
