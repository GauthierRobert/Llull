/** Where a library comes from: an inline object, or a file of this machine named by { libraryId, version } through `ctx.libraries`. */

import type { MaterialLibrary } from '../../model/materialLibrary';
import type { ExecutionContext } from '../types';
import { parseMaterialLibrary } from './libraryFormat';

export interface LibraryRequest {
  readonly library?: Record<string, unknown> | undefined;
  readonly libraryId?: string | undefined;
  readonly version?: string | undefined;
}

export type LibrarySource =
  | { readonly ok: true; readonly library: MaterialLibrary; readonly sha256: string; readonly inline: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly path: string };

const failure = (code: string, path: string, message: string): LibrarySource => ({ ok: false, code, path, message });

/**
 * Parse the inline library, or fetch and parse `libraryId@version` from the machine's library port.
 * @failure neither / both given PROP_FORM_INVALID; no port or file MAT_LIBRARY_UNRESOLVED; invalid content MAT_LIBRARY_INVALID (or a model code)
 */
export function loadLibrary(request: LibraryRequest, ctx: ExecutionContext | undefined, side = ''): LibrarySource {
  const prefix = side === '' ? '' : `${side}.`;
  const byReference = request.libraryId !== undefined;
  if (request.library !== undefined && byReference)
    return failure('PROP_FORM_INVALID', `${prefix}library`, 'give either the library object or { libraryId, version }, not both');
  if (request.library !== undefined) {
    const parsed = parseMaterialLibrary(request.library);
    if (parsed.ok && request.version !== undefined && request.version !== parsed.library.version)
      return failure(
        'PROP_FORM_INVALID',
        `${prefix}version`,
        `version '${request.version}' differs from the library's own version '${parsed.library.version}'`,
      );
    return parsed.ok
      ? { ok: true, library: parsed.library, sha256: parsed.sha256, inline: true }
      : failure(parsed.code, `${prefix}library.${parsed.path}`, parsed.message);
  }
  if (request.libraryId === undefined || request.version === undefined)
    return failure('PROP_FORM_INVALID', `${prefix}libraryId`, 'give the library object, or libraryId and version');
  const provider = ctx?.libraries ?? null;
  if (provider === null)
    return failure(
      'MAT_LIBRARY_UNRESOLVED',
      `${prefix}libraryId`,
      `no library provider is installed, so ${request.libraryId}@${request.version} cannot be read`,
    );
  const found = provider.get(request.libraryId, request.version);
  if (found === null)
    return failure(
      'MAT_LIBRARY_UNRESOLVED',
      `${prefix}libraryId`,
      `library ${request.libraryId}@${request.version} is not held on this machine`,
    );
  const parsed = parseMaterialLibrary(found);
  return parsed.ok
    ? { ok: true, library: parsed.library, sha256: parsed.sha256, inline: false }
    : failure(parsed.code, `${prefix}libraryId`, `library ${request.libraryId}@${request.version}: ${parsed.message}`);
}
