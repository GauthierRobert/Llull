/** set_thread (07 FTR M2, FR-FTR-19): the cosmetic thread attribute of a hole feature; geometry and `recipeKey` never change. */

import type { MeshSolidEntity } from '../../model/types';
import type { HoleSpec, ThreadSpec } from '../../model/features';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { editFeatureNode, featureNodes } from '../../geometry/featureInstances';
import { refuse } from './ftr';
import { parseThread, threadSchema } from './threads';

const withThread = (hole: HoleSpec, thread: ThreadSpec | null): HoleSpec => {
  const copy: { -readonly [K in keyof HoleSpec]: HoleSpec[K] } = { ...hole };
  if (thread === null) delete copy.thread;
  else copy.thread = thread;
  return copy;
};

/**
 * @affects modifies 1 mesh entity: the thread of one hole feature in its recipe (same id)
 * @invariant the shape recipe key and the mesh are unchanged; `thread: null` removes the attribute
 * @failure missing entity / no such hole feature (FTR_PART_NOT_FOUND), designation fails its family grammar (FTR_THREAD_DESIGNATION_INVALID) -> rejected no-op
 */
export const setThread = defineCommand({
  name: 'set_thread',
  description:
    'Set (or remove) the cosmetic thread of a hole feature made by add_hole: a designation such as "MJ6x1-4H5H" or ".1900-32 UNJF-3B", ' +
    'checked against a light per-family grammar. It is an attribute for drawings, hole_table and code export; the geometry and the shape ' +
    'recipe key are NOT changed. featureIndex counts the hole/pocket features of the part in the order they were cut (0 = first add_hole or ' +
    'add_pocket on the original solid); hole ids in hole_table read hole-<featureIndex>.<position>. Refusal codes: FTR_PART_NOT_FOUND, ' +
    'FTR_THREAD_DESIGNATION_INVALID.',
  params: z.object({
    id: z.string().describe('Id of the mesh entity made by add_hole.'),
    featureIndex: z
      .number()
      .int()
      .min(0)
      .describe('Index of the hole feature among the part features (add_hole / add_pocket steps in cutting order, from 0).'),
    thread: threadSchema
      .nullable()
      .describe(
        'The thread to set, or null to remove it. designation is checked against its family grammar; depth is in document length units.',
      ),
  }),
  run: (doc, { id, featureIndex, thread }): CommandResult => {
    const entity = doc.entities[id];
    const nodes = entity?.kind === 'mesh' && entity.brep !== undefined ? featureNodes(entity.brep) : [];
    const node = nodes[featureIndex];
    if (entity?.kind !== 'mesh' || entity.brep === undefined || node?.feature !== 'hole')
      return refuse(
        doc,
        'set_thread',
        'FTR_PART_NOT_FOUND',
        entity === undefined ? `entity '${id}' not found` : `'${id}' has no hole feature number ${featureIndex}`,
        'pass a mesh made by add_hole and a featureIndex of one of its holes',
        [id],
        entity === undefined ? ['id'] : ['featureIndex'],
      );
    const spec = thread === null ? null : parseThread(thread);
    if (thread !== null && spec === null)
      return refuse(
        doc,
        'set_thread',
        'FTR_THREAD_DESIGNATION_INVALID',
        `thread designation '${thread.designation}' fails the grammar of its family`,
        "use the family's designation form, e.g. MJ6x1-4H5H",
        [id],
        ['thread.designation'],
      );
    const brep = editFeatureNode(entity.brep, featureIndex, (current) => {
      if (current.feature !== 'hole') return current;
      return { ...current, hole: withThread(current.hole, spec) };
    });
    const next: MeshSolidEntity = { ...entity, brep };
    const what = spec === null ? 'removed the thread' : `thread ${spec.designation} (${spec.family}, cosmetic)`;
    return changed(
      { ...doc, entities: { ...doc.entities, [id]: next } },
      `set_thread: ${what} on hole feature ${featureIndex} of '${id}'; geometry and recipe key unchanged.`,
      [id],
    );
  },
});
