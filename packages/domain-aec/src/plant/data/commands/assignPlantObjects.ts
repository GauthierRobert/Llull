import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { getPlantData, withPlantData } from '../model';
import { assignObject } from './assignObject';
import { assignItemSchema } from './assignPlantObject';
import { refuse } from './params';

/**
 * @affects creates up to 10 000 plant objects (plant.data) as ONE step; writes each tag into its model object
 * @invariant the same as assign_plant_object per item, applied in order (item k sees the tags of items 0..k-1); atomic: one refused item refuses the batch; linear in the batch size
 * @failure the first refused item's DAT_* refusal, with its paths prefixed assignments[k], document unchanged
 */
export const assignPlantObjects = defineCommand({
  name: 'assign_plant_objects',
  description:
    'Classify many model objects as plant objects in ONE atomic step (bulk assign_plant_object, up to 10 000; the one-by-one command is quadratic). ' +
    'assignments: the parameters of assign_plant_object per item (target, className, hierarchy, tagFields / tag / nextSequence, properties, provenance, line), ' +
    'applied in order, so an item sees the tags of the earlier ones (nextSequence: true numbers them consecutively). One refused item refuses the whole batch ' +
    'with the DAT_* code of assign_plant_object and paths prefixed assignments[k]. Returns data = { count, assigned [{ objectId, tag, className }] } and the ' +
    'plant object ids (then the retagged model object ids) in affected. Next: set_plant_properties, check_plant_data, plant_data_table.',
  params: z.object({ assignments: z.array(assignItemSchema).min(1).max(10000).describe('The assignments, in order.') }),
  run: (doc, { assignments }, ctx): CommandResult => {
    const data = getPlantData(doc);
    let current = withPlantData(doc, { ...data, objects: { ...data.objects }, objectOrder: [...data.objectOrder] });
    const assigned: Array<{ objectId: string; tag: string; className: string }> = [];
    const affected = new Set<string>();
    for (const [index, input] of assignments.entries()) {
      const outcome = assignObject(current, input, ctx, true);
      if (!outcome.ok)
        return refuse(doc, 'assign_plant_objects', {
          ...outcome,
          message: `assignments[${index}]: ${outcome.message}`,
          paths: (outcome.paths ?? []).map((path) => `assignments[${index}].${path}`),
        });
      current = outcome.assigned.document;
      assigned.push({
        objectId: outcome.assigned.object.id,
        tag: outcome.assigned.object.tag,
        className: outcome.assigned.object.className,
      });
      for (const id of outcome.assigned.affected) affected.add(id);
    }
    const ids = assigned.map((entry) => entry.objectId);
    return {
      ...changed(
        current,
        `assign_plant_objects: ${assigned.length} plant objects (${assigned[0]?.tag}${assigned.length > 1 ? ` ... ${assigned[assigned.length - 1]?.tag}` : ''}).`,
        [...new Set([...ids, ...affected])],
      ),
      data: { count: assigned.length, assigned },
    };
  },
});
