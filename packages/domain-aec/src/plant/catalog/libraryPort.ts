/**
 * Private piping libraries (plant 01 PSC §2, `PipingLibraryProvider`): licensed catalogues live in files of the machine, outside the document, which
 * stores only `{ libraryId, version, sha256 }`. The host installs the provider (composition root); absent = every reference is unresolved
 * (`PSC_LIBRARY_UNRESOLVED`). The provider returns the file text, so the document's hash is the hash of the exact bytes.
 */

import { sha256Hex } from '@lib/sha256';
import { parseCatalogFile } from './file';
import type { PipingCatalog } from './types';

export interface PipingLibraryProvider {
  /** The library file text (`llull-piping-catalog` JSON) for `libraryId` at `version`, or null when this machine does not hold it. */
  get(libraryId: string, version: string): string | null;
}

let installed: PipingLibraryProvider | null = null;

/** Install (or with null, remove) the process piping-library provider. Composition roots only. */
export function setPipingLibraryProvider(provider: PipingLibraryProvider | null): void {
  installed = provider;
  cache.clear();
}

export type LibraryResolution =
  | { readonly status: 'resolved'; readonly catalog: PipingCatalog; readonly sha256: string }
  | { readonly status: 'unresolved'; readonly reason: string };

const cache = new Map<string, LibraryResolution>();
const CACHE_LIMIT = 16;

/** Reads, hashes and parses the file of `libraryId@version`; `expectedSha256` (when given) must match the file's hash. Never throws. */
export function resolveLibrary(libraryId: string, version: string, expectedSha256?: string): LibraryResolution {
  if (installed === null) return { status: 'unresolved', reason: 'no piping library provider is installed on this host' };
  const text = installed.get(libraryId, version);
  if (text === null) return { status: 'unresolved', reason: `library ${libraryId}@${version} is not on this machine` };
  const sha256 = sha256Hex(text);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256)
    return {
      status: 'unresolved',
      reason: `library ${libraryId}@${version} on this machine has sha256 ${sha256}, the document recorded ${expectedSha256}`,
    };
  const hit = cache.get(`${libraryId}|${sha256}`);
  if (hit !== undefined) return hit;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'unresolved', reason: `library ${libraryId}@${version} is not valid JSON` };
  }
  const parsed = parseCatalogFile(raw, true);
  const result: LibraryResolution =
    'issues' in parsed
      ? {
          status: 'unresolved',
          reason: `library ${libraryId}@${version} is not a valid catalogue: ${parsed.issues[0]?.message ?? 'invalid'}`,
        }
      : parsed.catalog.id !== libraryId
        ? { status: 'unresolved', reason: `library file ${libraryId}@${version} declares the id ${parsed.catalog.id}` }
        : { status: 'resolved', catalog: parsed.catalog, sha256 };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(`${libraryId}|${sha256}`, result);
  return result;
}
