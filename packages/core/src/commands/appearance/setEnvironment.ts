/** set_environment — what lights the scene besides light entities and the site sun: sky model, HDR map, flat colour (RV1 RV-M2). */

import type { AppearanceModel, SceneEnvironment } from '../../model/appearance';
import { isHexColor } from '../../lib/isHexColor';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { refuseAppearance } from './refusal';
import { textureOf } from './textureUse';

const COMMAND = 'set_environment';
const SKY_TURBIDITY_RANGE: readonly [number, number] = [1.7, 10];

/**
 * @affects CadDocument.appearance.environment (set, replaced or removed); textures and the rest of the slice are kept
 * @invariant sky turbidity in [1.7, 10]; intensity finite and >= 0; hdr names an existing hdr texture; rotation finite (radians)
 * @failure unknown source fields, non-finite or out-of-range numbers, missing texture, non-hdr texture, bad colour -> no-op with ENVIRONMENT_PARAM_INVALID / TEXTURE_* code
 */
export const setEnvironment = defineCommand({
  name: COMMAND,
  description:
    'Set the scene environment used by realistic renders and the viewport: source "sky" (Preetham sky, turbidity 1.7 clear .. 10 hazy), "hdr" (an equirectangular ' +
    'Radiance .hdr texture imported with import_texture, with rotation about the up axis in radians), "color" (a uniform hex colour), or "default" (removes the ' +
    'environment: the site sun plus the built-in ambient, as before). `intensity` (>= 0, default 1) multiplies the radiance. Replaces the previous environment. ' +
    'Refusals carry error.code ENVIRONMENT_PARAM_INVALID, TEXTURE_NOT_FOUND, TEXTURE_FORMAT_UNSUPPORTED.',
  params: z.object({
    source: z.enum(['sky', 'hdr', 'color', 'default']).describe('Where the environment light comes from; "default" removes it.'),
    turbidity: z.number().optional().describe('source sky: atmosphere haze, 1.7 (clear) .. 10 (hazy). Default 2.5.'),
    texture: z.string().optional().describe('source hdr (required): id of an hdr texture from import_texture.'),
    rotation: z.number().optional().describe('source hdr: rotation of the map about the up axis, radians. Default 0.'),
    color: z.string().optional().describe('source color (required): hex "#rrggbb".'),
    intensity: z.number().optional().describe('Radiance multiplier, >= 0. Default 1. Ignored for "default".'),
  }),
  run: (doc, params): CommandResult => {
    const reject = (code: string, message: string, path: string): CommandResult => refuseAppearance(doc, COMMAND, code, message, { path });
    const intensity = params.intensity ?? 1;
    if (!Number.isFinite(intensity) || intensity < 0)
      return reject('ENVIRONMENT_PARAM_INVALID', `intensity must be finite and >= 0, got ${intensity}`, 'intensity');
    let environment: SceneEnvironment | undefined;
    if (params.source === 'sky') {
      const turbidity = params.turbidity ?? 2.5;
      if (!Number.isFinite(turbidity) || turbidity < SKY_TURBIDITY_RANGE[0] || turbidity > SKY_TURBIDITY_RANGE[1])
        return reject(
          'ENVIRONMENT_PARAM_INVALID',
          `turbidity must be in [${SKY_TURBIDITY_RANGE[0]}, ${SKY_TURBIDITY_RANGE[1]}], got ${turbidity}`,
          'turbidity',
        );
      environment = { source: 'sky', turbidity, intensity };
    } else if (params.source === 'hdr') {
      if (params.texture === undefined) return reject('ENVIRONMENT_PARAM_INVALID', 'source hdr needs a texture id', 'texture');
      const texture = textureOf(doc, params.texture);
      if (texture === undefined)
        return reject('TEXTURE_NOT_FOUND', `texture '${params.texture}' is not imported in this document`, 'texture');
      if (texture.format !== 'hdr')
        return reject('TEXTURE_FORMAT_UNSUPPORTED', `texture '${params.texture}' is ${texture.format}, not an hdr radiance map`, 'texture');
      const rotation = params.rotation ?? 0;
      if (!Number.isFinite(rotation)) return reject('ENVIRONMENT_PARAM_INVALID', 'rotation must be a finite number of radians', 'rotation');
      environment = { source: 'hdr', texture: params.texture, rotation, intensity };
    } else if (params.source === 'color') {
      if (params.color === undefined || !isHexColor(params.color))
        return reject('ENVIRONMENT_PARAM_INVALID', `source color needs a "#rrggbb" colour, got '${String(params.color)}'`, 'color');
      environment = { source: 'color', color: params.color, intensity };
    }
    const { environment: previous, ...rest } = doc.appearance ?? { textures: {}, textureOrder: [] };
    void previous;
    const model: AppearanceModel = { ...rest, ...(environment !== undefined ? { environment } : {}) };
    const empty = environment === undefined && model.textureOrder.length === 0;
    const { appearance: dropped, ...withoutSlice } = doc;
    void dropped;
    return changed(
      empty ? withoutSlice : { ...doc, appearance: model },
      environment === undefined
        ? 'set_environment: default lighting restored (site sun + built-in ambient).'
        : `set_environment: ${environment.source}${environment.source === 'sky' ? ` turbidity ${environment.turbidity}` : ''}${environment.source === 'hdr' ? ` texture ${environment.texture} rotation ${environment.rotation}` : ''}${environment.source === 'color' ? ` ${environment.color}` : ''}, intensity ${environment.intensity}.`,
      [],
    );
  },
});
