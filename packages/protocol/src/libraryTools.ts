/**
 * Material library file transport (hand-written schema like the exchange tools): `register_material_library` copies a library file into the
 * workstation store that `ctx.libraries` reads (`~/.llull/libraries/` on the server). No document change: the document refers to the library by
 * { libraryId, version, sha256 } (import_material_library, resolve_material_libraries).
 */
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import type { ExportMarking, LibraryStorage, LicenceFlag, MaterialLibrary } from '@core/model/materialLibrary';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import type { ToolDefinition } from './tools';
import { shapeToolCallContent, type ShapedToolResult } from './toolResult';

/** What registering a library file answers. */
export interface LibraryRegistration {
  readonly libraryId: string;
  readonly version: string;
  readonly sha256: string;
  readonly storage: LibraryStorage;
  readonly licence: LicenceFlag;
  readonly exportMarking: ExportMarking;
}

/** Port to the library store of the host (implemented in `server/`). Throws Error with an agent-readable message. */
export interface MaterialLibraryStorePort {
  register(library: MaterialLibrary, sha256: string): LibraryRegistration;
}

const TOOL_NAME = 'register_material_library';

export function buildLibraryToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: TOOL_NAME,
      description:
        'Register a material library file (format llull-material-library, *.llull-matlib.json) on this machine: it is validated, hashed and copied ' +
        'into the library store (LLULL_LIBRARIES_DIR, default ~/.llull/libraries/) that import_material_library and resolve_material_libraries ' +
        'read. Returns data { libraryId, version, sha256, licence, exportMarking, storage }. The document is not changed. A licensed library ' +
        '(licence licensed-no-redistribution) must have storage "private": its values then never enter a saved document. Next: ' +
        'import_material_library { libraryId, version, sha256 }. With the llull CLI pass file=<path>.',
      inputSchema: {
        type: 'object',
        properties: {
          libraryJson: { type: 'string', description: 'The library file text (JSON).' },
          storage: {
            type: 'string',
            enum: ['private', 'embedded'],
            description: 'Optional check: must equal the storage declared in the file ("private" = values stay on this machine).',
          },
        },
        required: ['libraryJson'],
      },
      annotations: { idempotentHint: true },
    },
  ];
}

const failure = (message: string): ShapedToolResult => shapeToolCallContent({ summary: message, affected: [], isError: true });

/**
 * Dispatch the register_material_library call; null for any other tool name.
 * @failure no store port, invalid JSON or library, storage differs from the file -> isError result with the MAT_* code, nothing stored
 */
export function applyLibraryToolCall(
  toolName: string,
  rawArgs: unknown,
  deps: { readonly libraries?: MaterialLibraryStorePort | null },
): ShapedToolResult | null {
  if (toolName !== TOOL_NAME) return null;
  const args = isRecord(rawArgs) ? rawArgs : {};
  const text = nonEmptyString(args['libraryJson']);
  if (text === undefined)
    return failure(`${TOOL_NAME}: libraryJson is required (the library file text; the CLI reads it with file=<path>).`);
  if (deps.libraries === undefined || deps.libraries === null)
    return failure(`${TOOL_NAME} MAT_LIBRARY_UNRESOLVED: this host has no library store (start the llull server or desktop app).`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure(`${TOOL_NAME} MAT_LIBRARY_INVALID: the file is not valid JSON.`);
  }
  const parsed = parseMaterialLibrary(raw);
  if (!parsed.ok) return failure(`${TOOL_NAME} ${parsed.code}: ${parsed.path}: ${parsed.message}`);
  const requested = args['storage'];
  if (requested !== undefined && requested !== parsed.library.storage)
    return failure(
      `${TOOL_NAME} MAT_LIBRARY_INVALID: storage "${String(requested)}" differs from the file's "${parsed.library.storage}"; nothing stored.`,
    );
  if (parsed.library.licence === 'licensed-no-redistribution' && parsed.library.storage === 'embedded')
    return failure(
      `${TOOL_NAME} MAT_LICENCE_EMBED_FORBIDDEN: library '${parsed.library.id}' is licensed-no-redistribution; set storage "private" in the file.`,
    );
  try {
    const registration = deps.libraries.register(parsed.library, parsed.sha256);
    return shapeToolCallContent({
      summary:
        `${TOOL_NAME}: ${registration.libraryId}@${registration.version} stored (${registration.storage}, licence ${registration.licence}, ` +
        `marking ${registration.exportMarking.regime}, sha256 ${registration.sha256}). Next: import_material_library with this sha256.`,
      affected: [],
      isError: false,
      data: registration,
    });
  } catch (error) {
    return failure(`${TOOL_NAME} failed: ${errorMessage(error)}`);
  }
}
