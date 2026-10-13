/**
 * Procedural, tileable PBR maps of a material finish — albedo (sRGB RGBA), tangent-space normal (OpenGL +Y convention, glTF / three.js) and
 * glTF metallicRoughness (G = roughness, B = metal) — computed from a height field per pattern. Pure and deterministic: the viewport and
 * the glTF export build byte-identical textures.
 */

import type { FinishPattern, Material } from '../model/types';
import { parseHexRgb } from '../lib/isHexColor';
import { map3 } from '../lib/vec3';
import { clamp } from '../lib/clamp';

/** Texture tile edge in pixels. */
const FINISH_TEXTURE_SIZE = 256;

/** RGBA maps of one finish tile (`size` × `size` pixels each). */
export interface FinishMaps {
  readonly size: number;
  readonly albedo: Uint8Array;
  readonly normal: Uint8Array;
  readonly metallicRoughness: Uint8Array;
}

type Rgb = readonly [number, number, number];

/** What one pattern says about a pixel at tile coordinates u, v in [0, 1). */
interface Sample {
  /** Relief height in [0, 1]. */
  readonly height: number;
  /** Blend from `color` (0) to `color2` (1). */
  readonly tint: number;
  /** Brightness multiplier around 1 (fibre streaks, gaps). */
  readonly shade: number;
  /** Roughness multiplier around 1. */
  readonly rough: number;
}

function hexRgb(hex: string): Rgb {
  return parseHexRgb(hex) ?? [128, 128, 128];
}

/** Integer hash → [0, 1) (deterministic, tileable when the inputs wrap). */
function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Woven carbon: `twill` shifts the over/under pattern one tow per row (2×2 twill). */
function weave(u: number, v: number, twill: boolean): Sample {
  const tows = 8;
  const i = Math.floor(u * tows);
  const j = Math.floor(v * tows);
  const horizontal = twill ? (((i - j) % 4) + 4) % 4 < 2 : (i + j) % 2 === 0;
  const across = horizontal ? v * tows - j : u * tows - i;
  const along = horizontal ? u * tows - i : v * tows - j;
  const profile = Math.sqrt(Math.max(0, 1 - (2 * across - 1) ** 2));
  const fibres = 0.5 + 0.5 * Math.sin(2 * Math.PI * (across * 14 + hash(i, j) * 3));
  const swell = 0.92 + 0.08 * Math.sin(Math.PI * along);
  return {
    height: profile * swell,
    tint: horizontal ? 0 : 1,
    shade: (0.7 + 0.3 * profile) * (0.94 + 0.06 * fibres),
    rough: 0.85 + 0.3 * (1 - profile),
  };
}

function sampleAt(pattern: FinishPattern, u: number, v: number, size: number): Sample {
  switch (pattern) {
    case 'carbon_twill':
      return weave(u, v, true);
    case 'carbon_plain':
      return weave(u, v, false);
    case 'brushed': {
      const row = Math.floor(v * size);
      const streak = 0.5 * hash(row, 7) + 0.5 * hash(Math.floor(u * 6), row);
      return { height: streak * 0.4, tint: 0, shade: 0.9 + 0.12 * streak, rough: 0.75 + 0.5 * streak };
    }
    case 'knurl': {
      const n = 12;
      const tri = (t: number): number => 1 - Math.abs(2 * (t - Math.floor(t)) - 1);
      const peak = Math.min(tri((u + v) * n), tri((u - v) * n));
      return { height: peak, tint: 0, shade: 0.8 + 0.2 * peak, rough: 1.1 - 0.2 * peak };
    }
    case 'checker': {
      const odd = (Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 1;
      return { height: 0, tint: odd ? 1 : 0, shade: 1, rough: 1 };
    }
  }
}

const clampByte = (value: number): number => clamp(Math.round(value), 0, 255);

/**
 * Tileable maps of `material.finish` (null without a finish). `color2` defaults to the base colour lightened by 18 % (the sheen of crossing
 * tows).
 */
export function finishMaps(
  material: Pick<Material, 'color' | 'metalness' | 'roughness' | 'finish'>,
  size = FINISH_TEXTURE_SIZE,
): FinishMaps | null {
  const finish = material.finish;
  if (finish === undefined) return null;
  const base = hexRgb(material.color);
  const second = finish.color2 !== undefined ? hexRgb(finish.color2) : map3(base, (c) => Math.min(255, c * 1.18 + 10));
  const strength = finish.normalStrength ?? 1;
  const pixels = size * size;
  const heights = new Float32Array(pixels);
  const albedo = new Uint8Array(pixels * 4);
  const metallicRoughness = new Uint8Array(pixels * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const s = sampleAt(finish.pattern, (x + 0.5) / size, (y + 0.5) / size, size);
      heights[p] = s.height;
      for (let c = 0; c < 3; c++) {
        const mixed = (base[c] as number) * (1 - s.tint) + (second[c] as number) * s.tint;
        albedo[p * 4 + c] = clampByte(mixed * s.shade);
      }
      albedo[p * 4 + 3] = 255;
      metallicRoughness[p * 4] = 0;
      metallicRoughness[p * 4 + 1] = clampByte(material.roughness * s.rough * 255);
      metallicRoughness[p * 4 + 2] = clampByte(material.metalness * 255);
      metallicRoughness[p * 4 + 3] = 255;
    }
  }
  const normal = new Uint8Array(pixels * 4);
  const relief = 2.5 * strength;
  const h = (x: number, y: number): number => heights[((y + size) % size) * size + ((x + size) % size)] as number;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * relief;
      const dy = (h(x, y + 1) - h(x, y - 1)) * relief;
      const length = Math.hypot(dx, dy, 1);
      const p = (y * size + x) * 4;
      normal[p] = clampByte((-dx / length) * 127.5 + 127.5);
      normal[p + 1] = clampByte((-dy / length) * 127.5 + 127.5);
      normal[p + 2] = clampByte((1 / length) * 127.5 + 127.5);
      normal[p + 3] = 255;
    }
  }
  return { size, albedo, normal, metallicRoughness };
}

/**
 * Box-projected texture coordinates of one triangle corner: the facet's dominant normal axis picks the projection plane, one texture tile
 * per `scale` document units.
 */
export function boxUv(point: readonly number[], facetNormal: readonly number[], scale: number): [number, number] {
  const [ax, ay, az] = facetNormal.map(Math.abs) as [number, number, number];
  const [x, y, z] = [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0];
  if (az >= ax && az >= ay) return [x / scale, y / scale];
  if (ay >= ax) return [x / scale, z / scale];
  return [y / scale, z / scale];
}
