/** Channel parameters shared by the appearance commands: zod shapes, validation against the document's textures, merge, material colour sync. */

import type { Appearance, ColorChannel, ScalarChannel } from '../../model/appearance';
import type { CadDocument, Material } from '../../model/types';
import { isHexColor } from '../../lib/isHexColor';
import { z } from '../schema';
import { textureOf } from './textureUse';

export const CLEARABLE_CHANNELS = [
  'baseColor',
  'metalness',
  'roughness',
  'normal',
  'emission',
  'emissionStrength',
  'transmission',
  'ior',
  'coat',
  'coatRoughness',
  'uvScale',
  'all',
] as const;

const scalarShape = z.object({
  value: z.number().optional().describe('Constant value of the channel; multiplies the texture when both are given.'),
  texture: z.string().optional().describe('Texture id from import_texture (not an hdr texture).'),
});

const colorShape = z.object({
  value: z.string().optional().describe('Hex "#rrggbb"; tints the texture when both are given.'),
  texture: z.string().optional().describe('Texture id from import_texture (not an hdr texture); use an srgb texture for colour maps.'),
});

/** A number, or `{ value?, texture? }`. */
export const scalarChannelParam = z.union([z.number(), scalarShape]);

/** A "#rrggbb" string, or `{ value?, texture? }`. */
export const colorChannelParam = z.union([z.string(), colorShape]);

export const normalParam = z.object({
  texture: z.string().describe('Tangent-space normal-map texture id from import_texture; import it with colorSpace linear.'),
  normalScale: z.number().optional().describe('Strength of the normal map xy, 0..4. Default 1.'),
});

/** The appearance channel parameters of `set_material_appearance`, as parsed by its schema. */
export interface ChannelParams {
  readonly baseColor?: string | { value?: string | undefined; texture?: string | undefined } | undefined;
  readonly metalness?: number | { value?: number | undefined; texture?: string | undefined } | undefined;
  readonly roughness?: number | { value?: number | undefined; texture?: string | undefined } | undefined;
  readonly normal?: { texture: string; normalScale?: number | undefined } | undefined;
  readonly emission?: string | { value?: string | undefined; texture?: string | undefined } | undefined;
  readonly emissionStrength?: number | undefined;
  readonly transmission?: number | { value?: number | undefined; texture?: string | undefined } | undefined;
  readonly ior?: number | undefined;
  readonly coat?: number | { value?: number | undefined; texture?: string | undefined } | undefined;
  readonly coatRoughness?: number | undefined;
  readonly uvScale?: number | undefined;
  readonly clear?: readonly (typeof CLEARABLE_CHANNELS)[number][] | undefined;
}

const SRGB_CHANNELS: ReadonlySet<string> = new Set(['baseColor', 'emission']);

const TEXTURE_CHANNELS = ['baseColor', 'metalness', 'roughness', 'normal', 'emission', 'transmission', 'coat'] as const;

/** [channel, texture id] of every channel of `appearance` that references a texture. */
function textureChannels(appearance: Appearance): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const channel of TEXTURE_CHANNELS) {
    const id = appearance[channel]?.texture;
    if (id !== undefined) pairs.push([channel, id]);
  }
  return pairs;
}

const UNIT_CHANNELS = ['metalness', 'roughness', 'transmission', 'coat'] as const;

type Checked = { readonly appearance: Appearance } | { readonly code: string; readonly message: string; readonly path: string };

const inUnit = (x: number): boolean => Number.isFinite(x) && x >= 0 && x <= 1;

function scalarOf(name: string, input: ChannelParams[(typeof UNIT_CHANNELS)[number]]): ScalarChannel | string {
  const channel = typeof input === 'number' ? { value: input } : (input ?? {});
  if (channel.value === undefined && channel.texture === undefined) return `${name} needs a value or a texture`;
  if (channel.value !== undefined && !inUnit(channel.value)) return `${name}.value must be a finite number in [0, 1], got ${channel.value}`;
  return {
    ...(channel.value !== undefined ? { value: channel.value } : {}),
    ...(channel.texture !== undefined ? { texture: channel.texture } : {}),
  };
}

function colorOf(name: string, input: ChannelParams['baseColor']): ColorChannel | string {
  const channel = typeof input === 'string' ? { value: input } : (input ?? {});
  if (channel.value === undefined && channel.texture === undefined) return `${name} needs a value or a texture`;
  if (channel.value !== undefined && !isHexColor(channel.value))
    return `${name}.value must be a "#rrggbb" hex colour, got '${channel.value}'`;
  return {
    ...(channel.value !== undefined ? { value: channel.value } : {}),
    ...(channel.texture !== undefined ? { texture: channel.texture } : {}),
  };
}

function numberProblem(name: string, value: number | undefined, ok: (x: number) => boolean, range: string): string | null {
  return value === undefined || (Number.isFinite(value) && ok(value)) ? null : `${name} must be ${range}, got ${value}`;
}

/** The appearance after applying `input` over `base` (a channel given replaces that channel; `clear` removes channels first), or the first problem. */
export function mergeChannels(doc: CadDocument, base: Appearance | undefined, input: ChannelParams): Checked {
  const bad = (code: string, message: string, path: string): Checked => ({ code, message, path });
  let next: Record<string, unknown> = { ...base };
  delete next['libraryId'];
  for (const name of input.clear ?? []) {
    if (name === 'all') next = {};
    else delete next[name];
  }
  for (const name of UNIT_CHANNELS) {
    if (input[name] === undefined) continue;
    const channel = scalarOf(name, input[name]);
    if (typeof channel === 'string') return bad('APPEARANCE_PARAM_INVALID', channel, name);
    next[name] = channel;
  }
  for (const name of ['baseColor', 'emission'] as const) {
    if (input[name] === undefined) continue;
    const channel = colorOf(name, input[name]);
    if (typeof channel === 'string') return bad('APPEARANCE_PARAM_INVALID', channel, name);
    next[name] = channel;
  }
  if (input.normal !== undefined) {
    const scale = input.normal.normalScale;
    const problem = numberProblem('normal.normalScale', scale, (x) => x >= 0 && x <= 4, 'in [0, 4]');
    if (problem !== null) return bad('APPEARANCE_PARAM_INVALID', problem, 'normal.normalScale');
    next['normal'] = { texture: input.normal.texture, ...(scale !== undefined ? { normalScale: scale } : {}) };
  }
  const scalars: ReadonlyArray<[string, number | undefined, (x: number) => boolean, string]> = [
    ['emissionStrength', input.emissionStrength, (x) => x >= 0, '>= 0'],
    ['ior', input.ior, (x) => x >= 1 && x <= 3, 'in [1, 3]'],
    ['coatRoughness', input.coatRoughness, inUnit, 'in [0, 1]'],
    ['uvScale', input.uvScale, (x) => x > 0, '> 0'],
  ];
  for (const [name, value, ok, range] of scalars) {
    const problem = numberProblem(name, value, ok, range);
    if (problem !== null) return bad('APPEARANCE_PARAM_INVALID', problem, name);
    if (value !== undefined) next[name] = value;
  }
  const appearance = next as Appearance;
  for (const [channel, id] of textureChannels(appearance)) {
    const texture = textureOf(doc, id);
    if (texture === undefined) return bad('TEXTURE_NOT_FOUND', `texture '${id}' is not imported in this document`, `${channel}.texture`);
    if (texture.format === 'hdr')
      return bad('TEXTURE_COLOR_SPACE', `texture '${id}' is hdr (linear radiance), not a surface map`, `${channel}.texture`);
    const needed = SRGB_CHANNELS.has(channel) ? 'srgb' : 'linear';
    if (texture.colorSpace !== needed)
      return bad(
        'TEXTURE_COLOR_SPACE',
        `${channel} needs a ${needed} texture but '${id}' is ${texture.colorSpace}; import it with colorSpace ${needed}`,
        `${channel}.texture`,
      );
  }
  return { appearance };
}

/** `material` with its colour, metalness and roughness following the value parts of `appearance` (so render_view and other consumers agree). */
export function syncMaterial(material: Material, appearance: Appearance | undefined): Material {
  const color = appearance?.baseColor?.value;
  const metalness = appearance?.metalness?.value;
  const roughness = appearance?.roughness?.value;
  const { appearance: previous, ...rest } = material;
  void previous;
  return {
    ...rest,
    ...(appearance !== undefined && Object.keys(appearance).length > 0 ? { appearance } : {}),
    ...(color !== undefined && isHexColor(color) ? { color } : {}),
    ...(metalness !== undefined ? { metalness } : {}),
    ...(roughness !== undefined ? { roughness } : {}),
  };
}

/** One-line description of the channels an appearance sets, for summaries. */
export function describeAppearance(appearance: Appearance): string {
  const channels = Object.entries(appearance)
    .filter(([name]) => name !== 'libraryId')
    .map(([name, value]) => {
      if (typeof value === 'number') return `${name} ${value}`;
      const channel = value as { value?: number | string; texture?: string };
      const parts = [
        channel.value !== undefined ? String(channel.value) : null,
        channel.texture !== undefined ? `texture ${channel.texture}` : null,
      ];
      return `${name} ${parts.filter((part) => part !== null).join(' + ')}`;
    });
  return channels.length === 0 ? 'no channels' : channels.join(', ');
}
