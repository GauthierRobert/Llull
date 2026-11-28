// Pure: an `Appearance` (entity override over the material's) resolved to the values of one three.js physical material, plus the image
// maps to request. No three.js, no React. A channel whose texture is missing (dangling id), still loading or failed takes its no-map
// value, so the surface falls back to the material colour silently.

import type { Appearance, TextureColorSpace, TextureRecord } from '@core/model/appearance';

export type MapChannel = 'baseColor' | 'metalness' | 'roughness' | 'normal' | 'emission' | 'transmission' | 'coat';

/** Colour data is sRGB, data maps linear: decided by the channel, not by the record flag. */
const CHANNEL_COLOR_SPACE: Readonly<Record<MapChannel, TextureColorSpace>> = {
  baseColor: 'srgb',
  emission: 'srgb',
  metalness: 'linear',
  roughness: 'linear',
  normal: 'linear',
  transmission: 'linear',
  coat: 'linear',
};

/** Document units one texture tile spans when UVs are box-projected (`Appearance.uvScale` default). */
const DEFAULT_UV_SCALE = 100;

export interface MapRequest {
  readonly channel: MapChannel;
  /** Image asset store key (`GET /assets/image/<key>`). */
  readonly key: string;
  readonly colorSpace: TextureColorSpace;
}

export interface SurfaceFallback {
  readonly color: string;
  readonly metalness: number;
  readonly roughness: number;
}

export interface SurfacePlan {
  readonly color: string;
  readonly metalness: number;
  readonly roughness: number;
  readonly emissive: string;
  readonly emissiveIntensity: number;
  readonly transmission: number;
  readonly ior: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  readonly normalScale: number;
  readonly uvScale: number;
}

type TextureTable = Readonly<Record<string, TextureRecord>>;

function textureIdOf(appearance: Appearance, channel: MapChannel): string | undefined {
  switch (channel) {
    case 'baseColor':
      return appearance.baseColor?.texture;
    case 'metalness':
      return appearance.metalness?.texture;
    case 'roughness':
      return appearance.roughness?.texture;
    case 'normal':
      return appearance.normal?.texture;
    case 'emission':
      return appearance.emission?.texture;
    case 'transmission':
      return appearance.transmission?.texture;
    case 'coat':
      return appearance.coat?.texture;
  }
}

const CHANNELS = Object.keys(CHANNEL_COLOR_SPACE) as MapChannel[];

/** The image maps `appearance` references that the document actually holds (HDR textures are environment-only). */
export function mapRequests(appearance: Appearance, textures: TextureTable): MapRequest[] {
  const requests: MapRequest[] = [];
  for (const channel of CHANNELS) {
    const id = textureIdOf(appearance, channel);
    const record = id === undefined ? undefined : textures[id];
    if (record === undefined || record.format === 'hdr') continue;
    requests.push({ channel, key: record.key, colorSpace: CHANNEL_COLOR_SPACE[channel] });
  }
  return requests;
}

/** `loaded`: channels whose texture is ready; every other channel resolves as if it had no map. */
export function surfacePlan(appearance: Appearance, fallback: SurfaceFallback, loaded: ReadonlySet<MapChannel>): SurfacePlan {
  const mapped = (channel: MapChannel): boolean => loaded.has(channel);
  const emissionOn = appearance.emission !== undefined && (appearance.emission.value !== undefined || mapped('emission'));
  return {
    color: appearance.baseColor?.value ?? (mapped('baseColor') ? '#ffffff' : fallback.color),
    metalness: appearance.metalness?.value ?? (mapped('metalness') ? 1 : fallback.metalness),
    roughness: appearance.roughness?.value ?? (mapped('roughness') ? 1 : fallback.roughness),
    emissive: emissionOn ? (appearance.emission?.value ?? '#ffffff') : '#000000',
    emissiveIntensity: emissionOn ? (appearance.emissionStrength ?? 1) : 0,
    transmission: appearance.transmission?.value ?? (mapped('transmission') ? 1 : 0),
    ior: appearance.ior ?? 1.5,
    clearcoat: appearance.coat?.value ?? (mapped('coat') ? 1 : 0),
    clearcoatRoughness: appearance.coatRoughness ?? 0.1,
    normalScale: appearance.normal?.normalScale ?? 1,
    uvScale: appearance.uvScale ?? DEFAULT_UV_SCALE,
  };
}
