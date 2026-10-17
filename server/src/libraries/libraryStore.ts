/**
 * Material library store of this machine: `<dir>/<id>@<version>.llull-matlib.json`, read through `ctx.libraries` (`MaterialLibraryProvider`)
 * and written by the `register_material_library` transport (`MaterialLibraryStorePort`). A private (licensed) library stays in this directory:
 * documents refer to it by { libraryId, version, sha256 } only.
 * Environment: LLULL_LIBRARIES_DIR  directory (default ~/.llull/libraries), read on every call.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MaterialLibraryProvider } from '@core/commands/types';
import { libraryHash, parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import type { MaterialLibraryStorePort } from '@mcp/index';
import { safeFileName } from '@lib/safeFileName';
import { writeFileAtomic } from '../writeFileAtomic';

function librariesDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_LIBRARIES_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'libraries');
}

const fileOf = (directory: string, libraryId: string, version: string): string =>
  path.join(directory, `${safeFileName(libraryId, 'library')}@${safeFileName(version, 'version')}.llull-matlib.json`);

/** The library `libraryId@version` of this machine; null when absent, unreadable or not a valid library of that id and version. */
export function createLibraryProvider(env: NodeJS.ProcessEnv = process.env): MaterialLibraryProvider {
  return {
    get(libraryId, version) {
      try {
        const parsed = parseMaterialLibrary(JSON.parse(readFileSync(fileOf(librariesDir(env), libraryId, version), 'utf8')));
        return parsed.ok && parsed.library.id === libraryId && parsed.library.version === version ? parsed.library : null;
      } catch {
        return null;
      }
    },
  };
}

/** The sha256 of the library already stored as `file`, or null when there is none or it is unreadable (a corrupt file may be replaced). */
function storedHash(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = parseMaterialLibrary(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.ok ? libraryHash(parsed.library) : null;
  } catch {
    return null;
  }
}

/**
 * Writes a validated library into the directory (owner-only file).
 * @invariant a version is immutable: `<id>@<version>` already stored with another sha256 is refused (MAT_LIBRARY_EXISTS); the same content again is a no-op rewrite
 * @failure an id or version that is not its own safe file name (path separators, spaces, leading dot, > 64 chars) -> MAT_LIBRARY_INVALID, nothing written
 */
export function createLibraryStorePort(env: NodeJS.ProcessEnv = process.env): MaterialLibraryStorePort {
  return {
    register(library, sha256) {
      if (safeFileName(library.id, 'library') !== library.id || safeFileName(library.version, 'version') !== library.version)
        throw new Error(
          `MAT_LIBRARY_INVALID: library id '${library.id}' and version '${library.version}' must be file-safe (letters, digits, . _ -; at most 64; no leading . or _)`,
        );
      const directory = librariesDir(env);
      const file = fileOf(directory, library.id, library.version);
      const existing = storedHash(file);
      if (existing !== null && existing !== sha256)
        throw new Error(
          `MAT_LIBRARY_EXISTS: ${library.id}@${library.version} is already registered with sha256 ${existing}; versions are immutable, publish a new version`,
        );
      mkdirSync(directory, { recursive: true });
      writeFileAtomic(file, JSON.stringify(library), 0o600);
      return {
        libraryId: library.id,
        version: library.version,
        sha256,
        storage: library.storage,
        licence: library.licence,
        exportMarking: library.exportMarking,
      };
    },
  };
}
