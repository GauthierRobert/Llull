/**
 * add_mate: stores a mate between two instances as an ordinary constraint (solved by
 * `solve_constraints`; instance origins are the solver's point proxies).
 *
 * @layer core/commands
 */

import type { Constraint } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { instanceFrameRef, instanceRefsProblem } from './instanceFrameRef';
import { noop } from './noop';

/**
 * @command add_mate
 * @pure
 * @layer core/commands
 * @affects adds 1 constraint to document.constraints and document.constraintOrder
 * @invariant the stored constraint is an ordinary Constraint; solve_constraints can solve it
 * @invariant both a.instanceId and b.instanceId must exist as InstanceEntity in doc.entities
 * @failure unknown instanceId / non-instance entity → no-op, affected:[]
 * @failure unknown kind → no-op, affected:[]
 * @failure kind='distance' without value → no-op, affected:[]
 */
export const addMate = defineCommand({
  name: 'add_mate',
  description:
    'Add a mechanical mate (joint) between two InstanceEntity frames. ' +
    'A mate is stored as an ordinary constraint in doc.constraints so solve_constraints ' +
    'applies it with no extra steps. ' +
    'Supported kinds: "coincident" (two instance origins share the same position in XY), ' +
    '"parallel" (a named axis of instance A is parallel to a named axis of instance B), ' +
    '"distance" (the distance between two instance origins equals value). ' +
    '"a" and "b" identify the instances and the frame: ' +
    '{ instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
    'frame defaults to "origin". ' +
    'value is required for kind="distance" and may be a number or a parameter expression string. ' +
    'Returns the new constraint id in affected[0]. ' +
    'Call solve_constraints afterward to move instances to satisfy the mate.',
  params: z.object({
    kind: z
      .enum(['coincident', 'parallel', 'distance'])
      .describe(
        'Mate type. "coincident": two instance origins overlap in XY. ' +
          '"parallel": two instance axis frames are parallel in XY. ' +
          '"distance": the distance between two instance origins in XY equals value.',
      ),
    a: instanceFrameRef(
      'first',
      'First instance frame reference. ' +
        '{ instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
        'instanceId must be an existing InstanceEntity in doc.entities. ' +
        'frame defaults to "origin" (the instance world position).',
    ),
    b: instanceFrameRef(
      'second',
      'Second instance frame reference. Same shape as "a". ' +
        '{ instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }.',
    ),
    value: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Required for kind="distance". Target distance in document units. ' +
          'May be a plain number ("10", "3.5") or a parameter expression string ("gap", "width / 2").',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Optional explicit constraint id for the created mate. ' +
          'When omitted a unique id is generated. ' +
          'If the id already exists in the document the command is a no-op.',
      ),
  }),
  run: (doc, { kind, a, b, value, id }): CommandResult => {
    const refProblem = instanceRefsProblem(doc, 'add_mate', { a, b });
    if (refProblem !== null) return noop(doc, refProblem);
    if (kind === 'distance' && value === undefined) {
      return noop(
        doc,
        `add_mate: kind='distance' requires a 'value' field (number or expression string).`,
      );
    }

    const constraintId = id !== undefined && id.length > 0 ? id : nextId('mate');
    if (constraintId in doc.constraints) {
      return noop(
        doc,
        `add_mate: constraint id '${constraintId}' already exists — no change made.`,
      );
    }

    const refs = { a: { entityId: a.instanceId }, b: { entityId: b.instanceId } };
    const constraint: Constraint =
      kind === 'distance'
        ? { id: constraintId, kind, ...refs, value: value as number | string }
        : { id: constraintId, kind, ...refs };
    const newDoc = {
      ...doc,
      constraints: { ...doc.constraints, [constraintId]: constraint },
      constraintOrder: [...doc.constraintOrder, constraintId],
    };

    const frameA = a.frame ?? 'origin';
    const frameB = b.frame ?? 'origin';

    return {
      document: newDoc,
      summary:
        `add_mate: added '${kind}' mate ${constraintId} between instance '${a.instanceId}' (frame: ${frameA}) ` +
        `and instance '${b.instanceId}' (frame: ${frameB})` +
        (kind === 'distance' ? ` with value=${String(value)}.` : '.'),
      affected: [constraintId],
    };
  },
});
