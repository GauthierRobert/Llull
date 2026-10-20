/** Reviewer dispositions on prototype findings (PHY-21 FR-FPR-31 / 32; acceptance is human-gated through ctx.caller, spec 11 Q5). */

import { DISPOSITION_STATUSES, type Disposition } from '../../model/prototype';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, codedRejection, failer } from '../noop';
import { isFindingKey } from '../persistence/prototypeValidation';
import { prototypeOf } from './intents';

const NAME = 'set_review_disposition';

/** The part / joint ids a finding key names (`<check>:<code>:<id,id>`). */
const idsOfKey = (findingKey: string): string[] =>
  findingKey
    .split(':')
    .slice(2)
    .join(':')
    .split(',')
    .map((id) => id.replace(/@.*$/, ''))
    .filter((id) => id.length > 0);

/**
 * @affects sets or clears doc.prototype.dispositions[findingKey] (affected: the ids the finding key names)
 * @invariant an `accepted` disposition never changes a check status: check_prototype reports the item as "fail (accepted)" and the verdict
 *   stays blocked while any fail remains; `by` is the host-declared caller kind ('agent' when the context carries none, spec 11 Q5)
 * @failure accepted by an agent caller -> FPR_HUMAN_GATE (acceptance is a human act, FR-FPR-31, AF-34); malformed finding key, empty inputsHash,
 *   same status + comment as stored -> no-op; not_reviewed with an empty comment removes the disposition (no-op when there is none)
 */
export const setReviewDisposition = defineCommand({
  name: NAME,
  description:
    'Record a reviewer status and comment on one finding of check_prototype (pass the findingKey of the item and the inputsHash of its check, data.checks[].inputsHash; the stand-alone ' +
    'checks run with other parameters, so their hashes differ and would read stale): status "relevant" (needs work), "irrelevant" (does not apply, say why), "accepted" (known and accepted as is) or ' +
    '"not_reviewed". Stored in the document (doc.prototype.dispositions) with the inputsHash of the check it was made on: when that check is ' +
    're-run on changed inputs the disposition is kept but flagged stale for re-review. An "accepted" disposition NEVER turns a fail into a ' +
    'pass: the item reads "fail (accepted)" and check_prototype stays blocked while a fail remains. "not_reviewed" with an empty comment ' +
    'clears the disposition. Next: check_prototype.',
  params: z.object({
    findingKey: z
      .string()
      .describe('The item findingKey from the check result, "<check>:<code>:<sorted ids>", e.g. "assembly:FPR_PAIR_HARD:box-1.1,box-2.1".'),
    status: z.enum(DISPOSITION_STATUSES).describe('"not_reviewed", "relevant", "irrelevant" or "accepted".'),
    comment: z.string().optional().describe('Reviewer comment (why it is irrelevant / accepted, what to do). Default empty.'),
    inputsHash: z
      .string()
      .describe(
        'The inputsHash of the check_prototype check the finding came from (data.checks[].inputsHash); a later different hash marks it stale.',
      ),
  }),
  run: (doc, { findingKey, status, comment = '', inputsHash }, ctx): CommandResult => {
    const fail = failer(doc, NAME);
    if (status === 'accepted' && ctx?.caller?.kind === 'agent')
      return codedRejection(
        doc,
        NAME,
        'FPR_HUMAN_GATE',
        'accepting a finding is a human act; an agent may mark it relevant or irrelevant',
        'Ask the reviewer to accept it in the desktop app (Review tab).',
        [findingKey],
      );
    if (!isFindingKey(findingKey))
      return fail(
        `'${findingKey}' is not a finding key (<check>:<code>:<ids>, check one of assembly, mechanism, motion_clearance, dynamics)`,
      );
    if (inputsHash.trim().length === 0) return fail('inputsHash must be the non-empty hash of the check result');
    const prototype = prototypeOf(doc);
    const stored = prototype.dispositions?.[findingKey];
    const text = comment.trim();
    const affected = idsOfKey(findingKey);
    if (status === 'not_reviewed' && text.length === 0) {
      if (stored === undefined) return fail(`'${findingKey}' has no disposition to clear`);
      const dispositions = Object.fromEntries(Object.entries(prototype.dispositions ?? {}).filter(([key]) => key !== findingKey));
      return changed({ ...doc, prototype: { ...prototype, dispositions } }, `Cleared the disposition of ${findingKey}.`, affected);
    }
    if (stored !== undefined && stored.status === status && stored.comment === text && stored.inputsHash === inputsHash)
      return fail(`'${findingKey}' is already ${status} with the same comment`);
    const disposition: Disposition = {
      findingKey,
      status,
      comment: text,
      inputsHash,
      by: ctx?.caller?.kind === 'human' ? 'human' : 'agent',
    };
    const dispositions = { ...prototype.dispositions, [findingKey]: disposition };
    const note =
      status === 'accepted' ? ' Recorded only: an accepted fail still reads "fail (accepted)" and keeps check_prototype blocked.' : '';
    return changed(
      { ...doc, prototype: { ...prototype, dispositions } },
      `Marked ${findingKey} ${status}${text.length > 0 ? ` ("${text}")` : ''} (by ${disposition.by}, hash ${inputsHash}).${note}`,
      affected,
    );
  },
});
