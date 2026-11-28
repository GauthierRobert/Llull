/** set_material_appearance — layered physically based appearance of a material, each channel a value or a texture (RV1 RV-M1). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import {
  CLEARABLE_CHANNELS,
  colorChannelParam,
  describeAppearance,
  mergeChannels,
  normalParam,
  scalarChannelParam,
  syncMaterial,
} from './appearanceChannels';
import { refuseAppearance } from './refusal';

const COMMAND = 'set_material_appearance';

/**
 * @affects CadDocument.materials[material].appearance (and color / metalness / roughness, which follow the value parts); affected = []
 * @invariant a channel given replaces that channel, the others are kept; density, record and finish are untouched; textures must exist and not be hdr
 * @failure unknown material, bad value or range, unknown / hdr texture, a channel with neither value nor texture -> no-op with APPEARANCE_* / TEXTURE_* code
 */
export const setMaterialAppearance = defineCommand({
  name: COMMAND,
  description:
    'Set the visual appearance of a material (create_material first): base colour, metalness, roughness, normal map, emission, transmission (glass), ' +
    'index of refraction, clear coat; each channel is a constant value or a texture from import_texture, or both (the texture multiplied by the value). ' +
    'Visual only: mass, density and analysis keep using the material record. The material colour, metalness and roughness follow the value parts, so ' +
    'render_view and the viewport stay consistent. A channel you pass replaces that channel; channels you omit are kept; `clear` removes channels ("all" removes the whole appearance). ' +
    'Ranges: metalness, roughness, transmission, coat, coatRoughness 0..1; ior 1..3; emissionStrength >= 0; uvScale > 0 (document units one texture tile spans when the mesh has no UVs; default 100). ' +
    'Texture colour space must fit the channel: baseColor and emission need an srgb texture; normal, roughness, metalness, transmission and coat a linear one (import_texture colorSpace); hdr textures are never surface maps. ' +
    'Refusals carry error.code APPEARANCE_MATERIAL_NOT_FOUND, APPEARANCE_PARAM_INVALID, TEXTURE_NOT_FOUND, TEXTURE_COLOR_SPACE.',
  params: z.object({
    material: z.string().describe('Material name as given to create_material.'),
    baseColor: colorChannelParam.optional().describe('Base colour: hex "#rrggbb", or { value?, texture? } (texture tinted by value).'),
    metalness: scalarChannelParam.optional().describe('Metalness 0 (dielectric) .. 1 (metal): a number, or { value?, texture? }.'),
    roughness: scalarChannelParam.optional().describe('Roughness 0 (mirror) .. 1 (diffuse): a number, or { value?, texture? }.'),
    normal: normalParam.optional().describe('Tangent-space normal map { texture, normalScale? }.'),
    emission: colorChannelParam.optional().describe('Emitted colour: hex "#rrggbb", or { value?, texture? }; scaled by emissionStrength.'),
    emissionStrength: z.number().optional().describe('Emission multiplier, >= 0 (default 1 when emission is set).'),
    transmission: scalarChannelParam.optional().describe('Transmission 0 (opaque) .. 1 (glass): a number, or { value?, texture? }.'),
    ior: z.number().optional().describe('Index of refraction, 1..3 (glass 1.5, water 1.33). Default 1.5.'),
    coat: scalarChannelParam.optional().describe('Clear-coat layer strength 0..1: a number, or { value?, texture? }.'),
    coatRoughness: z.number().optional().describe('Roughness of the clear coat, 0..1.'),
    uvScale: z
      .number()
      .optional()
      .describe('Document units one texture tile spans when UVs are projected onto a mesh without stored UVs; > 0, default 100.'),
    clear: z
      .array(z.enum(CLEARABLE_CHANNELS))
      .optional()
      .describe(
        'Channels to remove before applying the others: baseColor, metalness, roughness, normal, emission, emissionStrength, transmission, ior, coat, coatRoughness, uvScale, or "all".',
      ),
  }),
  run: (doc, params): CommandResult => {
    const { material: name, ...channels } = params;
    if (!Object.hasOwn(doc.materials, name))
      return refuseAppearance(
        doc,
        COMMAND,
        'APPEARANCE_MATERIAL_NOT_FOUND',
        `no material '${name}' (known: ${Object.keys(doc.materials).join(', ') || 'none'})`,
        { ids: [name], path: 'material' },
      );
    const material = doc.materials[name];
    if (material === undefined)
      return refuseAppearance(doc, COMMAND, 'APPEARANCE_MATERIAL_NOT_FOUND', `no material '${name}'`, { ids: [name], path: 'material' });
    const merged = mergeChannels(doc, material.appearance, channels);
    if ('code' in merged) return refuseAppearance(doc, COMMAND, merged.code, merged.message, { ids: [name], path: merged.path });
    return changed(
      { ...doc, materials: { ...doc.materials, [name]: syncMaterial(material, merged.appearance) } },
      `set_material_appearance '${name}': ${describeAppearance(merged.appearance)}.`,
      [],
    );
  },
});
