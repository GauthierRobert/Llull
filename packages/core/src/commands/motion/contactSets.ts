import type { ContactSet } from '../../model/joints';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { idOrNext, idTaken } from '../../lib/explicitId';
import { entityOfKind } from '../entity/entityOfKind';
import { changed, noop } from '../noop';

/**
 * @affects adds 1 entry to doc.contactSets
 * @invariant every pair names two distinct existing InstanceEntity ids
 * @failure empty pairs / unknown or non-instance id / pair of one instance with itself / taken id -> no-op, affected:[]
 */
export const createContactSet = defineCommand({
  name: 'create_contact_set',
  description:
    'Define a contact set: pairs of instances that must not touch while a mechanism moves. motion_study (contactSetId) and drive_joint_to ' +
    '(contactSetId) stop the motion at the first value where any pair of the set touches (bounding boxes of the posed instances), ' +
    'bisecting to the exact contact value. Returns the set id in affected[0].',
  params: z.object({
    pairs: z
      .array(z.tuple([z.string(), z.string()]))
      .describe('Instance id pairs, e.g. [["slider","block"]]. Each id must be an existing InstanceEntity; the two ids of a pair differ.'),
    name: z.string().optional().describe('Display name. Default: the set id.'),
    id: z.string().optional().describe('Optional explicit set id (no-op if taken). Default: generated.'),
  }),
  run: (doc, { pairs, name, id }): CommandResult => {
    if (pairs.length === 0) return noop(doc, 'create_contact_set: pairs must contain at least one [idA, idB] pair.');
    for (const [a, b] of pairs) {
      if (a === b) return noop(doc, `create_contact_set: pair [${a}, ${b}] names one instance twice.`);
      for (const instanceId of [a, b]) {
        const found = entityOfKind(doc, instanceId, ['instance']);
        if (typeof found === 'string') return noop(doc, `create_contact_set: ${found}.`);
      }
    }
    const setId = idOrNext(id, 'contact');
    if (idTaken(doc.contactSets ?? {}, setId)) return noop(doc, `create_contact_set: contact set '${setId}' already exists.`);
    const set: ContactSet = { id: setId, name: name ?? setId, pairs: pairs.map(([a, b]): [string, string] => [a, b]) };
    return changed(
      { ...doc, contactSets: { ...doc.contactSets, [setId]: set } },
      `create_contact_set: '${setId}' with ${pairs.length} pair(s): ${pairs.map(([a, b]) => `${a}/${b}`).join(', ')}.`,
      [setId],
    );
  },
});

/**
 * @affects removes 1 entry from doc.contactSets
 * @failure unknown set id -> no-op, affected:[]
 */
export const deleteContactSet = defineCommand({
  name: 'delete_contact_set',
  annotations: { destructive: true },
  description: 'Remove a contact set by id. Joints and instances are untouched.',
  params: z.object({ id: z.string().describe('Id of the contact set to remove.') }),
  run: (doc, { id }): CommandResult => {
    if (!Object.hasOwn(doc.contactSets ?? {}, id)) return noop(doc, `delete_contact_set: contact set '${id}' does not exist.`);
    const contactSets = Object.fromEntries(Object.entries(doc.contactSets ?? {}).filter(([key]) => key !== id));
    return changed({ ...doc, contactSets }, `delete_contact_set: removed '${id}'.`, [id]);
  },
});
