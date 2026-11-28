/**
 * Appearance data (RV1 RV-M1, closes G6 / G7 / G8): image textures kept in the host's image asset store (content-addressed, outside the
 * document; the document holds a `TextureRecord`), layered physically based appearances (a value or a texture per channel), and the scene
 * environment (RV-M2). Visual only: an appearance never changes mass, analysis or exchange geometry.
 */

/** Texture file formats `import_texture` reads (the header is parsed for the size; pixels are decoded by the renderers). */
export const TEXTURE_FORMATS = ['png', 'jpeg', 'hdr'] as const;

type TextureFormat = (typeof TEXTURE_FORMATS)[number];

/** `srgb` = colour data (base colour, emission); `linear` = data maps (roughness, metalness, normal) and HDR radiance. */
export type TextureColorSpace = 'srgb' | 'linear';

/**
 * An imported image texture. Its bytes are the image asset store entry `key`.
 * @invariant key is 64 lowercase hex (sha256 of the file bytes); width, height integers in 1..TEXTURE_MAX_DIMENSION
 */
export interface TextureRecord {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly format: TextureFormat;
  readonly width: number;
  readonly height: number;
  /** File size in bytes. */
  readonly bytes: number;
  readonly colorSpace: TextureColorSpace;
}

/** One scalar channel: a value, a texture, or both (the texture value multiplied by `value`). */
export interface ScalarChannel {
  readonly value?: number;
  /** `TextureRecord.id`. */
  readonly texture?: string;
}

/** One colour channel: a `#rrggbb` value, a texture, or both (texture tinted by `value`). */
export interface ColorChannel {
  readonly value?: string;
  /** `TextureRecord.id`. */
  readonly texture?: string;
}

/**
 * A layered metal-roughness appearance (glTF / UsdPreviewSurface / Principled subset). Absent channels take the renderer default
 * (base colour = the material or entity colour, metalness 0, roughness 0.5, no emission, opaque, ior 1.5, no coat).
 * @invariant metalness, roughness, transmission, coat, coatRoughness values in [0, 1]; ior in [1, 3]; emissionStrength >= 0; uvScale > 0
 */
export interface Appearance {
  readonly baseColor?: ColorChannel;
  readonly metalness?: ScalarChannel;
  readonly roughness?: ScalarChannel;
  /** Tangent-space normal map; `normalScale` scales its xy. */
  readonly normal?: { readonly texture: string; readonly normalScale?: number };
  readonly emission?: ColorChannel;
  /** Emitted radiance multiplier (nits-like, renderer units), default 1 when `emission` is set. */
  readonly emissionStrength?: number;
  readonly transmission?: ScalarChannel;
  readonly ior?: number;
  readonly coat?: ScalarChannel;
  readonly coatRoughness?: number;
  /** Document units one texture tile spans when UVs are box-projected (meshes without stored UVs); default 100 (mm document: 100 mm). */
  readonly uvScale?: number;
  /** Library id this appearance was copied from (`apply_appearance`); absent when authored with `set_material_appearance`. */
  readonly libraryId?: string;
}

/** Scene environment (RV-M2 `set_environment`): what lights the scene besides light entities and the site sun. */
export type SceneEnvironment =
  | {
      readonly source: 'sky';
      /** Preetham turbidity, 1.7 (clear) .. 10 (hazy). */
      readonly turbidity: number;
      readonly intensity: number;
    }
  | {
      readonly source: 'hdr';
      /** `TextureRecord.id` of an `hdr` texture (equirectangular, linear radiance). */
      readonly texture: string;
      /** Rotation of the map about the up axis, radians. */
      readonly rotation: number;
      readonly intensity: number;
    }
  | { readonly source: 'color'; readonly color: string; readonly intensity: number };

/** `CadDocument.appearance`; absent until the first appearance / environment command. */
export interface AppearanceModel {
  readonly textures: Readonly<Record<string, TextureRecord>>;
  readonly textureOrder: readonly string[];
  /** Absent = the default lighting (site sun + the renderers' built-in ambient), the behaviour before RV-M2. */
  readonly environment?: SceneEnvironment;
}

/** Largest texture side in pixels (RV1 §5 "texture size cap"). */
export const TEXTURE_MAX_DIMENSION = 8192;

/** Decoded texture memory one document may reference (width × height × 4 bytes summed over its textures): 1 GiB (RV1 §5 "memory budget"). */
export const TEXTURE_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

/** Decoded size of one texture in bytes (RGBA8; an HDR texture counts 16 bytes per pixel, RGBA float32). */
export function textureMemoryBytes(texture: Pick<TextureRecord, 'width' | 'height' | 'format'>): number {
  return texture.width * texture.height * (texture.format === 'hdr' ? 16 : 4);
}

/** Entity override over the material appearance, channel by channel (what every renderer draws); undefined when neither has one. */
export function resolveAppearance(
  entity: { readonly appearance?: Appearance | undefined },
  material: { readonly appearance?: Appearance | undefined } | undefined,
): Appearance | undefined {
  const own = entity.appearance;
  const inherited = material?.appearance;
  if (own === undefined) return inherited;
  return inherited === undefined ? own : { ...inherited, ...own };
}
