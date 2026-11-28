/** import_texture — register a PNG / JPEG / Radiance HDR image as a document texture (RV1 RV-M1). */

import {
  type AppearanceModel,
  type TextureColorSpace,
  type TextureRecord,
  TEXTURE_MAX_DIMENSION,
  TEXTURE_MEMORY_BUDGET_BYTES,
  textureMemoryBytes,
} from '../../model/appearance';
import { base64ToUint8Array } from '../../lib/base64';
import { nextId } from '../../lib/id';
import { readImageHeader } from '../../lib/imageHeader';
import { sha256Hex } from '../../lib/sha256';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { documentTextureBytes } from './textureUse';
import { refuseAppearance } from './refusal';

const COMMAND = 'import_texture';
/** Inline (base64) images are recorded in the document step; larger files go through the asset store (`fileKey`). */
const MAX_INLINE_TEXTURE_BYTES = 1024 * 1024;

/**
 * @affects CadDocument.appearance.textures (+ textureOrder): adds one TextureRecord; affected = [texture id]
 * @invariant the bytes stay in the image asset store (key = sha256), the document holds the record; width / height come from the file header only
 * @invariant total decoded size of all textures (RGBA8, HDR float32 RGBA) never exceeds TEXTURE_MEMORY_BUDGET_BYTES; each side is at most TEXTURE_MAX_DIMENSION
 * @failure neither / both of fileKey and base64, bad base64, inline over 1 MiB -> TEXTURE_PARAM_INVALID; no asset store or key missing -> TEXTURE_ASSET_UNAVAILABLE;
 *   not PNG / JPEG / HDR -> TEXTURE_FORMAT_UNSUPPORTED; side > 8192 -> TEXTURE_TOO_LARGE; over the memory budget -> TEXTURE_BUDGET_EXCEEDED; name taken -> TEXTURE_NAME_EXISTS
 */
export const importTexture = defineCommand({
  name: COMMAND,
  description:
    'Register an image file as a named texture of the document: PNG, JPEG (sRGB colour or data maps) or Radiance .hdr (equirectangular environment, linear). ' +
    'Give the file as `fileKey` (sha256, 64 hex, of a file kept in the image asset store of this machine; the CLI stores `file=PATH` there and fills it, ' +
    'so the document keeps 64 hex characters, not the image) or as `base64` (small files, up to 1 MiB decoded, recorded in the document step; larger files: `file=PATH` in the CLI or fileKey). ' +
    'The size is read from the file header. Limits: each side at most 8192 px; all textures of a document together at most 1 GiB decoded (RGBA8 = 4 bytes per pixel, ' +
    'HDR = 16). Returns the texture id; use it in set_material_appearance (baseColor / roughness / metalness / normal / emission ... texture) or, for an hdr texture, in ' +
    'set_environment. `colorSpace` defaults to srgb for PNG / JPEG (colour maps: base colour, emission) and linear for hdr; pass linear for roughness, metalness and normal maps. ' +
    'Refusals carry error.code TEXTURE_PARAM_INVALID, TEXTURE_ASSET_UNAVAILABLE, TEXTURE_FORMAT_UNSUPPORTED, TEXTURE_TOO_LARGE, TEXTURE_BUDGET_EXCEEDED, TEXTURE_NAME_EXISTS.',
  params: z.object({
    name: z
      .string()
      .describe('Unique texture name in this document, e.g. "brushed_steel_albedo". Used by list_appearances; the id is minted.'),
    fileKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        'sha256 (64 lowercase hex) of an image kept in the image asset store (the CLI stores `file=PATH` and fills this). Give exactly one of fileKey or base64.',
      ),
    base64: z
      .string()
      .optional()
      .describe(
        'The image file bytes, base64 encoded (PNG, JPEG or .hdr), at most 1 MiB decoded (use fileKey / the CLI `file=` beyond); recorded in the document step. Give exactly one of fileKey or base64.',
      ),
    colorSpace: z
      .enum(['srgb', 'linear'])
      .optional()
      .describe(
        'How the pixel values are encoded: srgb = colour data (default for PNG / JPEG), linear = data maps (roughness, metalness, normal) and hdr (always linear).',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const reject = (code: string, message: string, path?: string, detail?: Record<string, unknown>): CommandResult =>
      refuseAppearance(doc, COMMAND, code, message, {
        ...(path !== undefined ? { path } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    if (params.name.trim() === '') return reject('TEXTURE_PARAM_INVALID', 'name must not be empty', 'name');
    if ((params.fileKey === undefined) === (params.base64 === undefined))
      return reject('TEXTURE_PARAM_INVALID', 'give exactly one of fileKey or base64', 'fileKey');
    const assets = ctx?.imageAssets ?? null;
    let bytes: Uint8Array;
    let key: string;
    if (params.fileKey !== undefined) {
      if (assets === null)
        return reject('TEXTURE_ASSET_UNAVAILABLE', 'no image asset store is installed here, so fileKey cannot be read', 'fileKey');
      const stored = assets.readImage(params.fileKey);
      if (stored === null)
        return reject(
          'TEXTURE_ASSET_UNAVAILABLE',
          `image ${params.fileKey} is not in the image asset store of the process running this command (LLULL_IMAGE_CACHE, default ~/.llull/cache/image)`,
          'fileKey',
        );
      bytes = stored;
      key = params.fileKey;
    } else {
      const decoded = base64ToUint8Array(params.base64 as string);
      if (decoded === null) return reject('TEXTURE_PARAM_INVALID', 'base64 is not valid base64', 'base64');
      if (decoded.length > MAX_INLINE_TEXTURE_BYTES)
        return reject(
          'TEXTURE_PARAM_INVALID',
          `inline image is ${decoded.length} bytes, over the ${MAX_INLINE_TEXTURE_BYTES} inline limit (1 MiB): use file=PATH in the CLI or fileKey`,
          'base64',
        );
      bytes = decoded;
      key = sha256Hex(bytes);
    }
    const header = readImageHeader(bytes);
    if (header === null || header.width < 1 || header.height < 1)
      return reject(
        'TEXTURE_FORMAT_UNSUPPORTED',
        'the file is not a readable PNG, JPEG or Radiance HDR image',
        params.fileKey !== undefined ? 'fileKey' : 'base64',
      );
    if (header.width > TEXTURE_MAX_DIMENSION || header.height > TEXTURE_MAX_DIMENSION)
      return reject(
        'TEXTURE_TOO_LARGE',
        `${header.width} x ${header.height} px exceeds the ${TEXTURE_MAX_DIMENSION} px side cap`,
        undefined,
        { width: header.width, height: header.height, maxDimension: TEXTURE_MAX_DIMENSION },
      );
    if (header.format === 'hdr' && params.colorSpace === 'srgb')
      return reject('TEXTURE_PARAM_INVALID', 'an hdr image is linear radiance; colorSpace srgb does not apply', 'colorSpace');
    const colorSpace: TextureColorSpace = header.format === 'hdr' ? 'linear' : (params.colorSpace ?? 'srgb');
    const existing = doc.appearance?.textures ?? {};
    if (Object.values(existing).some((texture) => texture.name === params.name))
      return reject('TEXTURE_NAME_EXISTS', `a texture named '${params.name}' already exists`, 'name');
    const used = documentTextureBytes(doc);
    const needed = textureMemoryBytes(header);
    if (used + needed > TEXTURE_MEMORY_BUDGET_BYTES)
      return reject(
        'TEXTURE_BUDGET_EXCEEDED',
        `${header.width} x ${header.height} ${header.format} needs ${needed} bytes decoded; ${used} of ${TEXTURE_MEMORY_BUDGET_BYTES} are already used`,
        undefined,
        { usedBytes: used, neededBytes: needed, budgetBytes: TEXTURE_MEMORY_BUDGET_BYTES },
      );
    if (params.base64 !== undefined && assets !== null) {
      try {
        assets.writeImage(bytes);
      } catch {
        return reject('TEXTURE_ASSET_UNAVAILABLE', 'the image asset store could not write the image', 'base64');
      }
    }
    const id = nextId('tex');
    const record: TextureRecord = {
      id,
      name: params.name,
      key,
      format: header.format,
      width: header.width,
      height: header.height,
      bytes: bytes.length,
      colorSpace,
    };
    const model: AppearanceModel = {
      ...doc.appearance,
      textures: { ...existing, [id]: record },
      textureOrder: [...(doc.appearance?.textureOrder ?? []), id],
    };
    return changed(
      { ...doc, appearance: model },
      `import_texture: '${params.name}' = ${id} (${header.format} ${header.width} x ${header.height}, ${bytes.length} bytes, ${colorSpace}, key ${key.slice(0, 12)}…); ` +
        `texture memory ${used + needed} of ${TEXTURE_MEMORY_BUDGET_BYTES} bytes.`,
      [id],
    );
  },
});
