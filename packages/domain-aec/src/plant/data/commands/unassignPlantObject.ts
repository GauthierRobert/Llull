import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { getPlantData, withPlantData, copyObject, type PlantObject } from '../model';
import { objectByRef } from '../registry';
import { refuse } from './params';

/**
 * @affects removes the given plant objects from plant.data (the model objects and their tag fields are left as they are); objects that named a removed line object lose that line
 * @invariant atomic; the tag of a removed object becomes free again
 * @failure unknown or ambiguous object -> DAT_OBJECT_UNKNOWN, document unchanged
 */
export const unassignPlantObject = defineCommand({
  name: 'unassign_plant_object',
  description:
    'Remove plant objects (classification, tag registration and typed properties) by id or tag; the model objects (equipment, pipes, lines) stay and keep ' +
    'the tag field they were given. Pipes or components that named a removed process line object (assign_plant_object line) lose that link. All objects are ' +
    'resolved first: one unknown or ambiguous reference refuses the whole call. Returns data = { removed [{ id, tag }], detached (ids that lost their line) }. ' +
    'Refusals: DAT_OBJECT_UNKNOWN. Next: assign_plant_object.',
  params: z.object({
    objects: z
      .array(z.string())
      .min(1)
      .max(10000)
      .describe('Plant object ids (plantobj-3.1) or tags (P-101; use the id when a tag exists in several plants).'),
  }),
  run: (doc, params): CommandResult => {
    const data = getPlantData(doc);
    const removed = new Map<string, PlantObject>();
    for (const [index, reference] of params.objects.entries()) {
      const object = objectByRef(data, reference);
      if (object === null || object === 'ambiguous')
        return refuse(doc, 'unassign_plant_object', {
          code: 'DAT_OBJECT_UNKNOWN',
          message: object === null ? `no plant object "${reference}"` : `tag "${reference}" exists in several scopes: pass the id`,
          paths: [`objects[${index}]`],
        });
      removed.set(object.id, object);
    }
    const detached: string[] = [];
    const objects: Record<string, PlantObject> = {};
    for (const id of data.objectOrder) {
      const object = data.objects[id] as PlantObject;
      if (removed.has(id)) continue;
      if (object.lineId !== undefined && removed.has(object.lineId)) {
        objects[id] = copyObject(object, { lineId: null });
        detached.push(id);
      } else objects[id] = object;
    }
    const next = withPlantData(doc, { ...data, objects, objectOrder: data.objectOrder.filter((id) => !removed.has(id)) });
    return {
      ...changed(
        next,
        `unassign_plant_object: ${removed.size} object(s) removed (${[...removed.values()]
          .slice(0, 5)
          .map((object) => object.tag)
          .join(', ')}${removed.size > 5 ? ', ...' : ''}).`,
        [...removed.keys(), ...detached],
      ),
      data: { removed: [...removed.values()].map((object) => ({ id: object.id, tag: object.tag })), detached },
    };
  },
});
