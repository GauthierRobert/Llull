/** Reads of the appearance slice shared by the appearance commands. */

import type { Appearance, TextureRecord } from '../../model/appearance';
import { textureMemoryBytes } from '../../model/appearance';
import type { CadDocument } from '../../model/types';

/** Decoded bytes of every texture of the document (the figure the memory budget is checked against). */
export function documentTextureBytes(doc: CadDocument): number {
  let total = 0;
  for (const texture of Object.values(doc.appearance?.textures ?? {})) total += textureMemoryBytes(texture);
  return total;
}

/** The texture `id` of the document, or undefined. */
export function textureOf(doc: CadDocument, id: string): TextureRecord | undefined {
  const textures = doc.appearance?.textures;
  return textures !== undefined && Object.hasOwn(textures, id) ? textures[id] : undefined;
}

/** Texture ids an appearance references (base colour, metalness, roughness, normal, emission, transmission, coat). */
export function appearanceTextureIds(appearance: Appearance): string[] {
  const ids = [
    appearance.baseColor?.texture,
    appearance.metalness?.texture,
    appearance.roughness?.texture,
    appearance.normal?.texture,
    appearance.emission?.texture,
    appearance.transmission?.texture,
    appearance.coat?.texture,
  ];
  return ids.filter((id): id is string => id !== undefined);
}
