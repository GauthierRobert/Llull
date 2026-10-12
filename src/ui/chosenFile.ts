/** @layer ui — file `<input>` helpers (browser side; no document change). */

import type React from 'react';

/**
 * The first file chosen in a file input, if any. Clears the input so picking the same file again
 * fires another change event.
 */
export function takeChosenFile(event: React.ChangeEvent<HTMLInputElement>): File | undefined {
  const file = event.target.files?.[0];
  event.target.value = '';
  return file;
}

/** `fileName` without its last extension ("site.dxf" -> "site"). */
export function fileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}
