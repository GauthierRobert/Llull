/** checkpoint_iteration / submit_for_review / reject_review / record_approval: work-in-progress iterations and the review state (FR-PLM-03/04/07). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, noop } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { Iteration, PlmModel, Revision } from '@core/model/plm';
import type { ExecutionContext } from '@core/commands/types';
import { refusePlm } from '../refusal';
import { NOT_MANAGED, currentRevisionOf, revisionText, scopeHash, stateChange } from '../state';
import { humanAct } from '../gate';
import { withRevision } from '../revisions';
import { atSchema, bySchema, confirmationSchema } from '../params';

/** The plm record and its current revision, or the refusal that explains why the command cannot start. */
function managed(
  doc: CadDocument,
  command: string,
  state: Revision['state'],
  hint: string,
): { readonly plm: PlmModel; readonly revision: Revision } | CommandResult {
  const plm = doc.plm;
  if (plm === undefined) return refusePlm(doc, command, 'PLM_NOT_MANAGED', NOT_MANAGED);
  const revision = currentRevisionOf(plm);
  if (revision === undefined) return refusePlm(doc, command, 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no current revision`);
  if (revision.state !== state)
    return refusePlm(doc, command, 'PLM_STATE_TRANSITION', `${revisionText(plm)} is ${revision.state}; ${hint}`, [
      plm.item.partNumber,
      revision.label,
    ]);
  return { plm, revision };
}

const isRefusal = (value: unknown): value is CommandResult => typeof value === 'object' && value !== null && 'document' in value;

const nextIteration = (
  revision: Revision,
  hash: string,
  at: string | undefined,
  by: string | undefined,
  comment: string | undefined,
): Iteration => ({
  n: revision.iterations.length + 1,
  contentHash: hash,
  ...(at !== undefined ? { at } : {}),
  ...(by !== undefined ? { by } : {}),
  ...(comment !== undefined ? { comment } : {}),
});

/** The revision with a new iteration when the definition changed since the last checkpoint, else unchanged. */
function checkpointed(
  doc: CadDocument,
  revision: Revision,
  ctx: ExecutionContext | undefined,
  at?: string,
  by?: string,
  comment?: string,
): Revision {
  const hash = scopeHash(doc, ctx);
  return revision.iterations.at(-1)?.contentHash === hash
    ? revision
    : { ...revision, iterations: [...revision.iterations, nextIteration(revision, hash, at, by, comment)] };
}

/**
 * @affects doc.plm.item.revisions[current].iterations (appends iteration n+1 when the release-scope hash differs from the last checkpoint)
 * @invariant a clean definition is a no-op (the summary says "nothing to checkpoint")
 * @failure not managed -> PLM_NOT_MANAGED; revision not in_work -> PLM_STATE_TRANSITION
 */
export const checkpointIteration = defineCommand({
  name: 'checkpoint_iteration',
  description:
    'Record a work-in-progress iteration (A.1, A.2, ...) of the current in_work revision: appends one when the definition changed since the last ' +
    'checkpoint, otherwise nothing changes ("nothing to checkpoint"). PLM-only edits never make the definition dirty.',
  annotations: { metaHistory: true },
  params: z.object({
    comment: z.string().optional().describe('Why this checkpoint (e.g. "design review actions closed").'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, { comment, at, by }, ctx): CommandResult => {
    const found = managed(doc, 'checkpoint_iteration', 'in_work', 'only an in_work revision has iterations');
    if (isRefusal(found)) return found;
    const next = checkpointed(doc, found.revision, ctx, at, by, comment);
    if (next === found.revision)
      return noop(
        doc,
        `${revisionText(found.plm)}: nothing to checkpoint (definition unchanged since iteration ${found.revision.iterations.length}).`,
      );
    return changed(
      withRevision(doc, found.plm, next.label, next),
      `${revisionText(found.plm)}: iteration ${next.label}.${next.iterations.length} recorded.`,
      [],
    );
  },
});

/**
 * @affects doc.plm.item.revisions[current] (state in_work -> in_review; a checkpoint when the definition is dirty)
 * @invariant from here the definition is frozen (release lock) until reject_review or release
 * @failure revision not in_work -> PLM_STATE_TRANSITION; requireMarking with marking 'undetermined' -> PLM_MARKING_UNDECIDED; unresolved parameter
 *   errors -> PLM_PARAMETER_ERRORS (all refusals, unchanged doc)
 */
export const submitForReview = defineCommand({
  name: 'submit_for_review',
  description:
    'Submit the current in_work revision for review: checkpoints it when dirty, moves it to in_review and freezes the definition. Refused while ' +
    'parameters have unresolved errors, or (policy.requireMarking) while the export marking is undetermined. Next: humans approve (record_approval), ' +
    'then release_item. An agent may do this step.',
  annotations: { metaHistory: true },
  params: z.object({ comment: z.string().optional().describe('Review request note.'), at: atSchema.optional(), by: bySchema.optional() }),
  run: (doc, { comment, at, by }, ctx): CommandResult => {
    const found = managed(doc, 'submit_for_review', 'in_work', 'only an in_work revision can be submitted for review');
    if (isRefusal(found)) return found;
    const { plm } = found;
    if (plm.policy.requireMarking && plm.item.marking.regime === 'undetermined')
      return refusePlm(
        doc,
        'submit_for_review',
        'PLM_MARKING_UNDECIDED',
        `${plm.item.partNumber} export marking is undetermined and policy.requireMarking is on`,
        [plm.item.partNumber],
      );
    const broken = Object.values(doc.parameters).filter((parameter) => parameter.error !== undefined);
    if (broken.length > 0)
      return refusePlm(
        doc,
        'submit_for_review',
        'PLM_PARAMETER_ERRORS',
        `parameters with unresolved errors: ${broken.map((p) => p.name).join(', ')}`,
        broken.map((p) => p.name),
      );
    const base = checkpointed(doc, found.revision, ctx, at, by, comment);
    const next: Revision = {
      ...base,
      state: 'in_review',
      stateHistory: [...base.stateHistory, stateChange('in_work', 'in_review', at, by, comment)],
    };
    return changed(
      withRevision(doc, plm, next.label, next),
      `${revisionText(plm)} submitted for review at iteration ${next.iterations.length}; definition frozen. Next: record_approval by ${plm.policy.requiredApprovalRoles.join(', ')}, then release_item.`,
      [],
    );
  },
});

/**
 * @affects doc.plm.item.revisions[current].state (in_review -> in_work); recorded approvals are dropped
 * @failure revision not in_review -> PLM_STATE_TRANSITION; empty comment -> PLM_PARAM_INVALID (refusals, unchanged doc)
 */
export const rejectReview = defineCommand({
  name: 'reject_review',
  description:
    'Send the in_review revision back to in_work (unfreezes the definition) with a mandatory comment explaining why. Recorded approvals are dropped.',
  annotations: { metaHistory: true },
  params: z.object({
    comment: z.string().describe('Why the review failed (non-empty).'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, { comment, at, by }): CommandResult => {
    const found = managed(doc, 'reject_review', 'in_review', 'only an in_review revision can be rejected');
    if (isRefusal(found)) return found;
    if (comment.trim() === '')
      return refusePlm(doc, 'reject_review', 'PLM_PARAM_INVALID', 'a rejection needs a non-empty comment', [], ['comment']);
    const next: Revision = {
      ...found.revision,
      state: 'in_work',
      approvals: [],
      stateHistory: [...found.revision.stateHistory, stateChange('in_review', 'in_work', at, by, comment)],
    };
    return changed(withRevision(doc, found.plm, next.label, next), `${revisionText(found.plm)} rejected back to in_work: ${comment}`, []);
  },
});

/**
 * @affects doc.plm.item.revisions[current].approvals (appends one approval)
 * @invariant one approval per (role, user); the role must be a policy role
 * @failure agent caller -> PLM_HUMAN_GATE; revision not in_review -> PLM_STATE_TRANSITION; unknown role -> PLM_APPROVALS_MISSING; duplicate -> no-op
 */
export const recordApproval = defineCommand({
  name: 'record_approval',
  description:
    "HUMAN GATE. Record a role's approval of the in_review revision (roles: policy.requiredApprovalRoles, default design-authority and checker). One " +
    'approval per (role, user). An agent caller gets PLM_HUMAN_GATE: hand over to the responsible person in the desktop app.',
  annotations: { metaHistory: true },
  params: z.object({
    role: z.string().min(1).describe("Approval role, e.g. 'design-authority' or 'checker'."),
    userId: z.string().min(1).optional().describe('Ignored: the approval is recorded under the signer of the confirmation (the trusted key record).'),
    confirmation: confirmationSchema,
    comment: z.string().optional().describe('Optional remark.'),
    at: atSchema.optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { role, comment, at } = params;
    const gate = humanAct(doc, 'record_approval', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const userId = gate.signer;
    const found = managed(doc, 'record_approval', 'in_review', 'approvals are recorded on an in_review revision');
    if (isRefusal(found)) return found;
    const { plm, revision } = found;
    if (!plm.policy.requiredApprovalRoles.includes(role))
      return refusePlm(
        doc,
        'record_approval',
        'PLM_APPROVALS_MISSING',
        `role '${role}' is not a policy role (${plm.policy.requiredApprovalRoles.join(', ')})`,
        [],
        ['role'],
      );
    if (revision.approvals.some((approval) => approval.role === role && approval.userId === userId))
      return noop(doc, `${revisionText(plm)}: ${userId} already approved as ${role}; no-op.`);
    const approval = { role, userId, ...(at !== undefined ? { at } : {}), ...(comment !== undefined ? { comment } : {}) };
    return changed(
      withRevision(doc, plm, revision.label, { ...revision, approvals: [...revision.approvals, approval] }),
      `${revisionText(plm)}: ${role} approval by ${userId} recorded.`,
      [],
    );
  },
});
