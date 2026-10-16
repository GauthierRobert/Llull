/** Grounded parts: parts treated as attached to the world by the connection check (PHY-21 FR-FPR-06). */

import { is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, failer } from '../noop';
import { prototypeOf } from './intents';

/**
 * @affects adds or removes ids in doc.prototype.grounded (affected: the ids that changed)
 * @invariant idempotent; order of first marking is kept
 * @failure unknown or 2D id, nothing to change -> no-op
 */
export const setPartGrounded = defineCommand({
  name: 'set_part_grounded',
  annotations: { idempotent: true },
  description:
    'Mark 3D entities or instances as attached to the world (grounded = true) or release them (false). check_assembly treats a part ' +
    'that is grounded, belongs to a fixed rigid body or is the child of a joint whose parent is the ground as an anchor: every part ' +
    'must connect to an anchor through joints, rigid bodies, fasteners or contact, else FPR_PART_FLOATING. Use it for frames, stands ' +
    'and bolted-down parts that have no dynamics body. Unknown or 2D ids and a request that changes nothing are no-ops. Next: ' +
    'check_assembly.',
  params: z.object({
    ids: z.array(z.string()).min(1).describe('Entity or instance ids to mark.'),
    grounded: z.boolean().describe('true = attach to the world, false = release.'),
  }),
  run: (doc, { ids, grounded }): CommandResult => {
    const fail = failer(doc, 'set_part_grounded');
    for (const id of ids) {
      const entity = doc.entities[id];
      if (entity === undefined) return fail(`entity '${id}' not found`);
      if (!is3D(entity)) return fail(`entity '${id}' is 2D (${entity.kind}); only solids and instances can be grounded`);
    }
    const prototype = prototypeOf(doc);
    const unique = [...new Set(ids)];
    const current = new Set(prototype.grounded);
    const touched = unique.filter((id) => current.has(id) !== grounded);
    if (touched.length === 0) return fail(`${unique.join(', ')} already ${grounded ? 'grounded' : 'not grounded'}`);
    const next = grounded ? [...prototype.grounded, ...touched] : prototype.grounded.filter((id) => !touched.includes(id));
    return changed(
      { ...doc, prototype: { ...prototype, grounded: next } },
      `${grounded ? 'Grounded' : 'Released'} ${touched.length} part(s): ${touched.join(', ')}. ${next.length} grounded in total.`,
      touched,
    );
  },
});
