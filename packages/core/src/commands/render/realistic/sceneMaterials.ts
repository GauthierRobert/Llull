/**
 * Materials of the path-traced scene (RV1 §5b): an entity's appearance (its override over its material's) resolved to one
 * `PathTraceMaterial`, deduplicated, with every referenced image texture listed once. Colours go from sRGB hex to scene-linear.
 * @pure
 */

import type { Appearance, TextureRecord } from '../../../model/appearance';
import type { PathTraceMaterial, PathTraceTextureRef, Rgb } from '../../../model/pathTrace';
import { parseHexRgb } from '../../../lib/isHexColor';
import { pow } from '../../../lib/pow';

/** The colour / metalness / roughness a surface has without an appearance (its material, else its entity colour). */
export interface SurfaceBase {
  readonly color: string;
  readonly metalness: number;
  readonly roughness: number;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4));

/** `#rrggbb` → scene-linear Rec.709; malformed input → mid grey. */
export function linearRgb(hex: string): Rgb {
  const rgb = parseHexRgb(hex);
  if (rgb === null) return [0.214, 0.214, 0.214];
  return [srgbToLinear(rgb[0] / 255), srgbToLinear(rgb[1] / 255), srgbToLinear(rgb[2] / 255)];
}

const scaled = ([r, g, b]: Rgb, k: number): Rgb => [r * k, g * k, b * k];

export class MaterialBank {
  readonly materials: PathTraceMaterial[] = [];
  readonly textures: PathTraceTextureRef[] = [];
  /** `TextureRecord` of `textures[i]`. */
  readonly textureRecords: TextureRecord[] = [];
  private readonly materialIndex = new Map<string, number>();
  private readonly textureIndex = new Map<string, number>();

  constructor(private readonly records: Readonly<Record<string, TextureRecord>>) {}

  /** Index of the material `appearance` over `base` gives. */
  materialOf(base: SurfaceBase, appearance: Appearance | undefined): number {
    const material = this.resolve(base, appearance ?? {});
    const key = JSON.stringify(material);
    let index = this.materialIndex.get(key);
    if (index === undefined) {
      index = this.materials.length;
      this.materials.push(material);
      this.materialIndex.set(key, index);
    }
    return index;
  }

  /** Index of an image texture, or null for a missing id or an HDR file (HDR maps light the environment only). */
  private texture(id: string | undefined, colorSpace: 'srgb' | 'linear'): number | null {
    if (id === undefined) return null;
    const record = Object.hasOwn(this.records, id) ? this.records[id] : undefined;
    if (record === undefined || record.format === 'hdr') return null;
    const key = `${id}|${colorSpace}`;
    let index = this.textureIndex.get(key);
    if (index === undefined) index = this.addTexture(record, colorSpace);
    this.textureIndex.set(key, index);
    return index;
  }

  /** Lists `record` (also an HDR environment map) and returns its index. */
  addTexture(record: TextureRecord, colorSpace: 'srgb' | 'linear'): number {
    const index = this.textures.length;
    const extension = record.format === 'jpeg' ? 'jpg' : record.format;
    this.textures.push({ file: `tex-${index}.${extension}`, format: record.format, colorSpace });
    this.textureRecords.push(record);
    return index;
  }

  private resolve(base: SurfaceBase, a: Appearance): PathTraceMaterial {
    const baseColorTexture = this.texture(a.baseColor?.texture, 'srgb');
    const metalnessTexture = this.texture(a.metalness?.texture, 'linear');
    const roughnessTexture = this.texture(a.roughness?.texture, 'linear');
    const emissionTexture = this.texture(a.emission?.texture, 'srgb');
    const transmissionTexture = this.texture(a.transmission?.texture, 'linear');
    const coatTexture = this.texture(a.coat?.texture, 'linear');
    const emits = a.emission !== undefined && (a.emission.value !== undefined || emissionTexture !== null);
    const color = a.baseColor?.value ?? (baseColorTexture !== null ? '#ffffff' : base.color);
    return {
      baseColor: linearRgb(color),
      baseColorTexture,
      metalness: a.metalness?.value ?? (metalnessTexture !== null ? 1 : base.metalness),
      metalnessTexture,
      roughness: a.roughness?.value ?? (roughnessTexture !== null ? 1 : base.roughness),
      roughnessTexture,
      normalTexture: this.texture(a.normal?.texture, 'linear'),
      normalScale: a.normal?.normalScale ?? 1,
      emission: emits ? scaled(linearRgb(a.emission?.value ?? '#ffffff'), a.emissionStrength ?? 1) : [0, 0, 0],
      emissionTexture: emits ? emissionTexture : null,
      transmission: a.transmission?.value ?? (transmissionTexture !== null ? 1 : 0),
      transmissionTexture,
      ior: a.ior ?? 1.5,
      coat: a.coat?.value ?? (coatTexture !== null ? 1 : 0),
      coatTexture,
      coatRoughness: a.coatRoughness ?? 0.1,
    };
  }
}
