import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { Draft, fail, findAny, isFail, refuse } from '../authoring/refs';
import { removeItem } from '../authoring/remove';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (the item and what depends on it: an equipment takes its nozzles and sub-equipment, a line its segments and inline items, a valve its actuating system, an instrument its signals and an emptied loop; a deleted inline item with heal merges its two segments)
 * @invariant no reference is left dangling: a segment end on a removed item becomes a free end at the same point; a segment that loses both ends goes; heal restores the route the inline item split (colinear junction points removed)
 * @failure item not found -> PID_ITEM_NOT_FOUND; a single segment (delete its line or its inline item) -> PID_ITEM_KIND; document unchanged
 */
export const deletePidItem = defineCommand({
  name: 'delete_pid_item',
  description:
    'Delete a P&ID item (equipment, nozzle, line, inline component, instrument, signal, actuating system, off-page connector, loop) by tag or id, with what depends on it: equipment ' +
    'removes its nozzles and sub-equipment, a line its segments and inline components, a valve its actuating system, an instrument its signal lines and a loop left empty. A segment end ' +
    'that touched a removed item becomes a free end at the same point; a segment that loses both ends is removed. Deleting an inline component with heal (default true) merges the ' +
    'two segments around it back into one with the route it had before add_pid_inline; heal=false leaves two segments with free ends. Returns affected = ids removed (a healed delete also lists the segment merged away); data = { removed, healed }. ' +
    'Refusals (document unchanged): PID_ITEM_NOT_FOUND, PID_ITEM_KIND (a lone segment: delete its line, or the inline item at its end).',
  params: z.object({
    item: z.string().min(1).describe('Tag, item id or line number of the item to delete.'),
    heal: z.boolean().optional().describe('For an inline component: merge the two segments around it back into one (default true).'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'delete_pid_item';
    const pid = getPid(doc);
    const item = findAny(pid, params.item, 'item');
    if (isFail(item)) return refuse(doc, name, item);
    if (item.kind === 'segment')
      return refuse(
        doc,
        name,
        fail('PID_ITEM_KIND', `${params.item} is a segment: delete its line, or the inline item at its end`, ['item'], [item.id]),
      );
    const draft = new Draft(pid);
    const { removed, healed } = removeItem(draft, item, params.heal ?? true);
    return {
      document: withPid(doc, draft.model()),
      summary: `delete_pid_item: removed ${removed.length} item(s) (${removed.join(', ')}) for ${item.kind} ${item.tag ?? item.id}${healed ? ', segments healed' : ''}`,
      affected: removed,
      data: { removed, healed },
    };
  },
});
