/** set_selection: the per-client selection (CadDocument.selection), changed only through a command. */

import { defineCommand, z } from '../schema';
import { noop, report } from '../noop';
import type { CommandResult } from '../types';

/**
 * @affects CadDocument.selection; no FeatureStep, never logged or synced (session command: selection is per-client view state)
 * @invariant unknown ids are dropped (and named in the summary); the result has no duplicates; mode replace sets, add appends, remove subtracts,
 *   toggle flips each id; order of the existing selection is kept
 * @failure no id exists (replace -> selection cleared when ids is empty, otherwise unchanged) -> unchanged document, affected []
 */
export const setSelection = defineCommand({
  name: 'set_selection',
  annotations: { session: true, idempotent: true },
  description:
    'Change which entities are selected (the selection that selection-based tools and the viewport highlight use). ' +
    'ids: entity ids; ids that do not exist are ignored. mode: "replace" (default) makes ids the whole selection (an empty list clears it), ' +
    '"add" appends them, "remove" removes them, "toggle" flips each one. Session command: not part of the feature history and not undoable.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe('Entity ids to select / deselect. Unknown ids are ignored. Empty with mode "replace" clears the selection.'),
    mode: z
      .enum(['replace', 'add', 'remove', 'toggle'])
      .optional()
      .describe('replace (default): ids become the selection; add: append; remove: subtract; toggle: flip each id.'),
  }),
  run: (doc, { ids, mode = 'replace' }): CommandResult => {
    const known = [...new Set(ids)].filter((id) => id in doc.entities);
    const ignored = [...new Set(ids)].filter((id) => !(id in doc.entities));
    const current = doc.selection;
    let next: string[];
    if (mode === 'replace') next = known;
    else if (mode === 'add') next = [...current, ...known.filter((id) => !current.includes(id))];
    else if (mode === 'remove') next = current.filter((id) => !known.includes(id));
    else next = [...current.filter((id) => !known.includes(id)), ...known.filter((id) => !current.includes(id))];
    const unchanged = next.length === current.length && next.every((id, index) => id === current[index]);
    const note = ignored.length > 0 ? ` (ignored unknown: ${ignored.join(', ')})` : '';
    if (unchanged) return noop(doc, `set_selection ${mode}: selection unchanged (${current.length} selected)${note}.`);
    return report({ ...doc, selection: next }, `set_selection ${mode}: ${next.length} selected${note}.`, { selection: next });
  },
});
