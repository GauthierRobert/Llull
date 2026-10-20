import { humanGate } from '../../model/humanGate';
import type { PmiItem } from '../../model/pmi';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { findPmi, pmiOf, refuse, withItem } from './pmiOps';

/**
 * @affects sets `review` on each listed item (accept: required false with acceptedBy / acceptedAt; reject: stays required, reason extended)
 * @invariant a verified Ed25519 signature by a TRUSTED key over this act is ALWAYS required (AF-34); a caller label (human / agent) never clears the
 *   gate, and with no signing port installed the command refuses. Not replayed (a signature is never stored): the sign-off of an item is
 *   carried across a replay only while its content is unchanged (history/carry.ts withCarriedPmi)
 * @failure no / agent signature (GDT_REVIEW_HUMAN_ONLY), unknown id (GDT_PMI_UNKNOWN), empty comment on reject -> coded refusal, document unchanged
 */
export const acceptPmiReview = defineCommand({
  name: 'accept_pmi_review',
  annotations: { metaHistory: true },
  description:
    'Record the decision of a qualified engineer on PMI items created or edited by commands (AF-33): accept clears review.required, reject ' +
    'keeps it and adds the comment to the reason. HUMAN GATE: it ALWAYS needs `confirmation`, a signature object produced in the desktop app with a trusted signing key over this act ' +
    '(the nonce, the ids, the decision and the comment) and verified by the port; an agent has none, and with no signing port it is refused. Refused with ' +
    'GDT_REVIEW_HUMAN_ONLY. `at` is the review date text as given (never read from a clock). Refusals: GDT_REVIEW_HUMAN_ONLY, GDT_PMI_UNKNOWN, ' +
    'GDT_NOTE_EMPTY (empty comment on reject).',
  params: z.object({
    pmiIds: z.array(z.string()).min(1).describe('Ids of the PMI items under review (list_pmi).'),
    decision: z.enum(['accept', 'reject']).describe('accept or reject.'),
    comment: z.string().describe('Reviewer comment, kept in the reason; required (non-empty) for reject.'),
    at: z.string().describe('Review date/time text, e.g. "2026-10-20"; stored as given.'),
    confirmation: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe('Human signature object from the desktop app (with a nonce field). Required; true or none is refused as an agent call.'),
  }),
  run: (doc, { pmiIds, decision, comment, at, confirmation }, ctx): CommandResult => {
    const command = 'accept_pmi_review';
    const unknown = pmiIds.filter((id) => findPmi(doc, id) === undefined);
    if (unknown.length > 0) return refuse(doc, command, 'GDT_PMI_UNKNOWN', `no PMI item ${unknown.join(', ')}`, unknown, ['pmiIds']);
    if (decision === 'reject' && comment.trim() === '')
      return refuse(doc, command, 'GDT_NOTE_EMPTY', 'a rejection needs a comment', [], ['comment']);
    const gate = humanGate(ctx?.humanSignature ?? null, 'PMI review', pmiIds, confirmation, { decision, comment: comment.trim() });
    if (!gate.cleared) return refuse(doc, command, 'GDT_REVIEW_HUMAN_ONLY', gate.reason, pmiIds, ['confirmation']);
    let next = doc;
    for (const id of pmiIds) {
      const item = findPmi(doc, id) as PmiItem;
      const review =
        decision === 'accept'
          ? { required: false, acceptedBy: gate.signer, acceptedAt: at, ...(comment === '' ? {} : { reason: comment }) }
          : {
              required: true,
              reason: `${item.review.reason ?? ''}${item.review.reason === undefined ? '' : '; '}rejected by ${gate.signer}: ${comment}`,
            };
      next = withItem(next, { ...item, review });
    }
    const open = Object.values(pmiOf(next).items).filter((item) => item.review.required).length;
    return changed(
      next,
      `accept_pmi_review: ${decision}ed ${pmiIds.length} item(s) by ${gate.signer}; ${open} item(s) still need review.`,
      pmiIds,
    );
  },
});
