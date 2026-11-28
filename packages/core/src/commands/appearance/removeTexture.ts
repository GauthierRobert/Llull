/** remove_texture — drop an imported texture that nothing uses, freeing its memory budget (RV1 RV-M1). */

import type { AppearanceModel } from '../../model/appearance';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { refuseAppearance } from './refusal';
import { appearanceTextureIds, documentTextureBytes, textureOf } from './textureUse';

const COMMAND = 'remove_texture';

/** What still references texture `id`: materials, entities (document and component) and the environment. */
function textureUsers(doc: CadDocument, id: string): string[] {
  const users: string[] = [];
  const uses = (appearance: Parameters<typeof appearanceTextureIds>[0] | undefined): boolean =>
    appearance !== undefined && appearanceTextureIds(appearance).includes(id);
  for (const [name, material] of Object.entries(doc.materials)) if (uses(material.appearance)) users.push(`material '${name}'`);
  for (const [entityId, entity] of Object.entries(doc.entities)) if (uses(entity.appearance)) users.push(`entity '${entityId}'`);
  for (const [componentId, component] of Object.entries(doc.components))
    for (const [entityId, entity] of Object.entries(component.entities))
      if (uses(entity.appearance)) users.push(`component '${componentId}' entity '${entityId}'`);
  const environment = doc.appearance?.environment;
  if (environment?.source === 'hdr' && environment.texture === id) users.push('the scene environment');
  return users;
}

/**
 * @affects CadDocument.appearance.textures (+ textureOrder): removes one TextureRecord; the asset bytes stay in the store; affected = []
 * @invariant only an unused texture is removed: no material, entity (document or component) or environment references it
 * @failure unknown id -> TEXTURE_NOT_FOUND; still referenced -> TEXTURE_IN_USE with the users listed, document unchanged
 */
export const removeTexture = defineCommand({
  name: COMMAND,
  description:
    'Remove an imported texture from the document and free its share of the texture memory budget. Refused while a material appearance, an entity override ' +
    '(including entities inside components) or the scene environment still references it: clear those first (set_material_appearance clear, ' +
    'clear_entity_appearance, set_environment default). The image file itself stays in the asset store. ' +
    'Refusals carry error.code TEXTURE_NOT_FOUND or TEXTURE_IN_USE.',
  params: z.object({ texture: z.string().describe('Texture id from import_texture / list_appearances.') }),
  run: (doc, params): CommandResult => {
    const record = textureOf(doc, params.texture);
    if (record === undefined)
      return refuseAppearance(doc, COMMAND, 'TEXTURE_NOT_FOUND', `texture '${params.texture}' is not imported in this document`, {
        path: 'texture',
      });
    const users = textureUsers(doc, params.texture);
    if (users.length > 0)
      return refuseAppearance(doc, COMMAND, 'TEXTURE_IN_USE', `texture '${params.texture}' is used by ${users.join(', ')}`, {
        ids: [params.texture],
        path: 'texture',
        detail: { users },
      });
    const { [params.texture]: removed, ...textures } = doc.appearance?.textures ?? {};
    void removed;
    const model: AppearanceModel = {
      ...doc.appearance,
      textures,
      textureOrder: (doc.appearance?.textureOrder ?? []).filter((id) => id !== params.texture),
    };
    const next = { ...doc, appearance: model };
    return changed(
      next,
      `remove_texture: '${record.name}' (${params.texture}) removed; texture memory in use ${documentTextureBytes(next)} bytes.`,
      [],
    );
  },
});
