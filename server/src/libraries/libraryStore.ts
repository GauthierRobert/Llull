/**
 * Material library store of this machine: `<dir>/<id>@<version>.llull-matlib.json`, read through `ctx.libraries` (`MaterialLibraryProvider`)
 * and written by the `register_material_library` transport (`MaterialLibraryStorePort`). A private (licensed) library stays in this directory:
 * documents refer to it by { libraryId, version, sha256 } only.
 * Environment: LLULL_LIBRARIES_DIR  directory (default ~/.llull/libraries), read on every call.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MaterialLibraryProvider } from '@core/commands/types';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
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

/** Writes a validated library into the directory (owner-only file); registering the same id and version again replaces it. */
export function createLibraryStorePort(env: NodeJS.ProcessEnv = process.env): MaterialLibraryStorePort {
  return {
    register(library, sha256) {
      const directory = librariesDir(env);
      mkdirSync(directory, { recursive: true });
      writeFileAtomic(fileOf(directory, library.id, library.version), JSON.stringify(library), 0o600);
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
