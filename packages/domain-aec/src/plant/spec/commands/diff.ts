/** `diff_pipe_spec` (plant 01 PSC M4): what changed between two revisions of a pipe spec. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../../catalog/codes';
import { diffSpecs } from '../diff';
import { findSpec, getSpecModel } from '../store';

/**
 * @affects none; data = { specId, fromRevision, toRevision, identical, changes, header, status, components: { added, removed, changed }, branchCells, insulation }
 * @invariant read-only; compares the canonical file forms, so only real content differences are reported; a revision against itself is identical
 * @failure unknown spec -> PSC_SPEC_UNKNOWN; unknown revision -> PSC_REVISION_UNKNOWN (the revisions that exist are listed)
 */
export const diffPipeSpec = defineCommand({
  name: 'diff_pipe_spec',
  description:
    'Compare two revisions of a piping spec and list what changed: header members (rating, corrosion allowance, size range, catalogues ...), status, components added / removed / changed ' +
    '(per component, each member that differs with its old and new value), branch-table cells and insulation rows. Use it to review a new draft revision before approve_pipe_spec, or to see why pipes bound to an older revision are stale. ' +
    'toRevision defaults to the newest. Refuses an unknown spec (PSC_SPEC_UNKNOWN) or revision (PSC_REVISION_UNKNOWN, listing the revisions). Next: check_pipe_spec on the new revision, assign_pipe_spec to move pipes onto it.',
  params: z.object({
    specId: z.string().describe('Spec id (list_pipe_specs).'),
    fromRevision: z.number().int().positive().describe('The older (base) revision number.'),
    toRevision: z.number().int().positive().describe('The revision to compare with. Default: the newest.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { specId, fromRevision, toRevision }): CommandResult => {
    const revisions = getSpecModel(doc).specs[specId];
    if (revisions === undefined || revisions.length === 0)
      return refuse(
        doc,
        'diff_pipe_spec',
        'PSC_SPEC_UNKNOWN',
        `no spec "${specId}" (specs in this document: ${getSpecModel(doc).specOrder.join(', ') || 'none'})`,
        [specId],
        ['specId'],
      );
    const known = revisions.map((spec) => spec.revision);
    const from = findSpec(doc, specId, fromRevision);
    const to = findSpec(doc, specId, toRevision);
    if (from === undefined || to === undefined)
      return refuse(
        doc,
        'diff_pipe_spec',
        'PSC_REVISION_UNKNOWN',
        `spec ${specId} has no revision ${from === undefined ? fromRevision : toRevision} (revisions: ${known.join(', ')})`,
        [specId],
        [from === undefined ? 'fromRevision' : 'toRevision'],
      );
    const diff = diffSpecs(from, to);
    const identical = diff.changes === 0;
    return report(
      doc,
      identical
        ? `diff_pipe_spec: ${specId} r${from.revision} and r${to.revision} are identical.`
        : `diff_pipe_spec: ${specId} r${from.revision} -> r${to.revision}: ${diff.changes} difference(s): ${diff.components.added.length} component(s) added, ${diff.components.removed.length} removed, ${diff.components.changed.length} changed, ${diff.branchCells.length} branch cell(s), ${diff.header.length} header member(s)${diff.status === null ? '' : `, status ${diff.status.from} -> ${diff.status.to}`}.`,
      { specId, fromRevision: from.revision, toRevision: to.revision, identical, ...diff },
    );
  },
});
