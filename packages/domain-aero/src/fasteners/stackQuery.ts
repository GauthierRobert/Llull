/** list_fastener_stacks (08 MAT, read-only): the placed stacks as plain data, the public read path other plugins compose through `execute` (L10). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { FastenerStack } from '@aero/fasteners/types';
import { familyOf, fastenerModel, sizeOf } from './fastenerDoc';
import { quantityToDoc } from './units';

/** Nominal diameter of the stack's fastener size in document units, null when the catalogue does not hold it. */
function nominalDiameter(doc: CadDocument, stack: FastenerStack): number | null {
  const family = familyOf(doc, stack.fastener.family);
  const size = family === undefined ? undefined : sizeOf(family, stack.fastener.diameterDash);
  return size === undefined ? null : quantityToDoc(doc, size.nominalDiameter.value, size.nominalDiameter.unit);
}

/**
 * @affects nothing (query)
 * @failure a stackId that is not in the document -> data.stacks = [] (the summary says so)
 */
export const listFastenerStacks = defineCommand({
  name: 'list_fastener_stacks',
  annotations: { readOnly: true },
  description:
    'List the fastener stacks placed in the document (insert_fastener_stack / insert_fastener_row), or the one named by stackId. Each entry: id (fst-<step>.<k>), ' +
    'axis { origin, direction } in document units, layers [{ entityId, thickness }] in stack order, familyId, diameterDash, nominalDiameter (document units, null when the ' +
    'catalogue has no such size), holeDiameter (document units, 0 = no hole cut), washerCount, hasNut, rowId, and the entity ids of the placed parts: fastenerInstanceId, washers [{ instanceId, side: head | nut }], nutInstanceId (absent without a nut). Used by joint_from_fastener_stack. Returns data.stacks; the document is unchanged.',
  params: z.object({ stackId: z.string().optional().describe('Only this stack (fst-<step>.<k>); absent = every stack.') }),
  run: (doc, { stackId }): CommandResult => {
    const stacks = Object.values(fastenerModel(doc).stacks).filter((stack) => stackId === undefined || stack.id === stackId);
    const entries = stacks.map((stack) => ({
      id: stack.id,
      axis: stack.axis,
      layers: stack.layers,
      familyId: stack.fastener.family,
      diameterDash: stack.fastener.diameterDash,
      nominalDiameter: nominalDiameter(doc, stack),
      holeDiameter: stack.holeDiameter,
      washerCount: stack.washers.length,
      fastenerInstanceId: stack.fastener.instanceId,
      washers: stack.washers.map((washer) => ({ instanceId: washer.instanceId, side: washer.side })),
      ...(stack.nut === undefined ? {} : { nutInstanceId: stack.nut.instanceId }),
      hasNut: stack.nut !== undefined,
      ...(stack.rowId === undefined ? {} : { rowId: stack.rowId }),
    }));
    return report(
      doc,
      entries.length === 0
        ? `list_fastener_stacks: no stack${stackId === undefined ? '' : ` '${stackId}'`} in the document.`
        : `list_fastener_stacks: ${entries.length} stack(s): ${entries.map((entry) => entry.id).join(', ')}.`,
      { stacks: entries },
    );
  },
});
