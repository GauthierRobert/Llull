/** Refusals of the appearance commands (AF-11): a stable TEXTURE_* / APPEARANCE_* / ENVIRONMENT_* code, the offending ids and path, and a one-line fix. */

import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { codedRejection } from '../noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  TEXTURE_PARAM_INVALID: 'follow the parameter description in `llull describe import_texture`',
  TEXTURE_ASSET_UNAVAILABLE:
    'import the file with the CLI (`import_texture file=PATH`) on the machine that runs the command, or pass base64; with --app the backend and the CLI must share LLULL_IMAGE_CACHE',
  TEXTURE_FORMAT_UNSUPPORTED: 'use a PNG, a JPEG or a Radiance .hdr file (RGBE, `-Y h +X w`); convert other formats first',
  TEXTURE_TOO_LARGE: 'downscale the image so both sides are at most 8192 px',
  TEXTURE_BUDGET_EXCEEDED: 'list_appearances shows the memory in use; downscale textures or use fewer of them',
  TEXTURE_NAME_EXISTS: 'pick another texture name (list_appearances shows the existing ones)',
  TEXTURE_NOT_FOUND: 'import_texture first, or read the ids with list_appearances',
  TEXTURE_COLOR_SPACE: 'an hdr texture is linear radiance: use it for set_environment source hdr, not for a surface channel',
  APPEARANCE_PARAM_INVALID: 'follow the parameter description in `llull describe set_material_appearance`',
  APPEARANCE_MATERIAL_NOT_FOUND: 'create_material first, or read the names with describe_scene',
  APPEARANCE_NOT_FOUND: 'read the library ids with list_appearances',
  APPEARANCE_TARGET_INVALID: 'give exactly one of material or entityIds; light, camera, 2D and curve entities carry no surface',
  ENVIRONMENT_PARAM_INVALID: 'follow the parameter description in `llull describe set_environment`',
};

/** A rejected result: summary `<command>: <code> — <message>; no-op.` with the error's ids / paths / fix. */
export function refuseAppearance(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  options: { readonly ids?: readonly string[]; readonly path?: string; readonly detail?: Readonly<Record<string, unknown>> } = {},
): CommandResult {
  return codedRejection(
    doc,
    command,
    code,
    message,
    REMEDIATION[code] ?? 'see the command description',
    options.ids ?? [],
    options.path !== undefined ? [options.path] : [],
    options.detail,
  );
}
