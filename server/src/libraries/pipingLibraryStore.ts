/**
 * Piping library store of this machine (plant 01 PSC): `<dir>/<id>@<version>.llull-piping.json`, read through the plugin port
 * `PipingLibraryProvider` (`import_piping_library`, `PSC_LIBRARY_UNRESOLVED`). A private (licensed) catalogue stays in this directory:
 * documents refer to it by { libraryId, version, sha256 } only. Files are placed by hand (copy the `llull-piping-catalog` file to the name above).
 * Environment: LLULL_PIPING_LIBRARIES_DIR  directory (default ~/.llull/piping-libraries), read on every call.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setPipingLibraryProvider, type PipingLibraryProvider } from '@aec/index';

/** Same shape as the id `import_piping_library` accepts; the version is held to it too, so a name never carries a path separator. */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** A library file larger than this is treated as absent (a catalogue is far smaller; it also bounds the memory a hostile file can take). */
export const MAX_PIPING_LIBRARY_BYTES = 32 * 1024 * 1024;

function pipingLibrariesDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_PIPING_LIBRARIES_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'piping-libraries');
}

/**
 * The file text of `libraryId@version` of this machine.
 * @failure id or version outside [A-Za-z0-9._-]{1,64} (traversal, separators), a missing, unreadable, non-regular or oversize file -> null
 */
export function createPipingLibraryProvider(env: NodeJS.ProcessEnv = process.env): PipingLibraryProvider {
  return {
    get(libraryId, version) {
      if (!SAFE_NAME.test(libraryId) || !SAFE_NAME.test(version)) return null;
      try {
        const file = path.join(pipingLibrariesDir(env), `${libraryId}@${version}.llull-piping.json`);
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > MAX_PIPING_LIBRARY_BYTES) return null;
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Installs the machine's piping library directory as the process `PipingLibraryProvider`. */
export function installPipingLibraryProvider(env: NodeJS.ProcessEnv = process.env): void {
  setPipingLibraryProvider(createPipingLibraryProvider(env));
}
