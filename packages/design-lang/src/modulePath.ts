/**
 * Module file paths: relative to the root design's folder, forward slashes, never leaving it. Pure string work (the host reads files).
 * @failure empty, absolute, drive-lettered, backslashed, `..`, NUL or not `.lld` -> DESIGN_MODULE_PATH
 */

import { DesignError } from './errors';

const refuse = (line: number, path: string, why: string): DesignError =>
  new DesignError(
    'DESIGN_MODULE_PATH',
    line,
    `module path "${path}" ${why}`,
    'Use a relative path inside the design folder: "parts/fan.lld".',
  );

/** `path` without `./` and `//` noise; the key modules are stored and embedded under. */
export function normalizeModulePath(path: string, line: number): string {
  if (path === '' || path.includes('\0')) throw refuse(line, path, 'is empty or malformed');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw refuse(line, path, 'is absolute');
  if (path.includes('\\')) throw refuse(line, path, 'uses backslashes');
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) throw refuse(line, path, 'leaves the design folder');
  const normalized = segments.join('/');
  if (!normalized.endsWith('.lld')) throw refuse(line, path, 'is not a .lld file');
  return normalized;
}
