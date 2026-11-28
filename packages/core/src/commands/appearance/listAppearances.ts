/** list_appearances — library entries, document textures with memory use, and who carries an appearance (RV1 RV-M1). */

import { APPEARANCE_LIBRARY } from '../../model/appearanceLibrary';
import { TEXTURE_MAX_DIMENSION, TEXTURE_MEMORY_BUDGET_BYTES, textureMemoryBytes } from '../../model/appearance';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { documentTextureBytes } from './textureUse';

/**
 * @invariant read-only: same document, affected [], the answer in data { library, textures, textureMemory, environment, materials, entities }
 */
export const listAppearances = defineCommand({
  name: 'list_appearances',
  annotations: { readOnly: true },
  description:
    'List what the appearance commands can use and have set: the offline library (ids for apply_appearance), the textures of this document ' +
    '(id, name, format, size, decoded bytes), texture memory used against the 1 GiB budget and the 8192 px side cap, the scene environment ' +
    '(set_environment) and which materials and entities carry an appearance. Read-only.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const textures = (doc.appearance?.textureOrder ?? []).flatMap((id) => {
      const texture = doc.appearance?.textures[id];
      return texture === undefined ? [] : [{ ...texture, decodedBytes: textureMemoryBytes(texture) }];
    });
    const used = documentTextureBytes(doc);
    const materials = Object.entries(doc.materials)
      .filter(([, material]) => material.appearance !== undefined)
      .map(([name, material]) => ({ name, libraryId: material.appearance?.libraryId ?? null, appearance: material.appearance }));
    const entities = doc.order
      .map((id) => doc.entities[id])
      .flatMap((entity) =>
        entity?.appearance === undefined
          ? []
          : [{ id: entity.id, libraryId: entity.appearance.libraryId ?? null, appearance: entity.appearance }],
      );
    const data = {
      library: APPEARANCE_LIBRARY.map(({ id, name, category, description, tintable }) => ({ id, name, category, description, tintable })),
      textures,
      textureMemory: { usedBytes: used, budgetBytes: TEXTURE_MEMORY_BUDGET_BYTES, maxDimension: TEXTURE_MAX_DIMENSION },
      environment: doc.appearance?.environment ?? null,
      materials,
      entities,
    };
    return report(
      doc,
      `list_appearances: ${data.library.length} library appearances; ${textures.length} textures (${used} of ${TEXTURE_MEMORY_BUDGET_BYTES} bytes); ` +
        `${materials.length} materials and ${entities.length} entities with an appearance; environment ${doc.appearance?.environment?.source ?? 'default'}.`,
      data,
    );
  },
});
