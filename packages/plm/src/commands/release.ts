/** release_item / revise_item / set_lifecycle_state: freezing a revision, opening the next one, retiring one (FR-PLM-04/06/10/11). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { ChangeRecord, PlmModel, Revision } from '@core/model/plm';
import { closeForCutIn } from '../effectivity';
import { mergedApprovals, plannedEffectivity, releaseFindings, unverifiedInScope } from '../readiness';
import { type PlmCode, refusePlm } from '../refusal';
import { revisionLabel } from '../schemes';
import { NOT_MANAGED, currentRevisionOf, humanGateRefusal, revisionText, scopeOf, stateChange } from '../state';
import { isLegalTransition, transitionRefusal } from '../transitions';
import { openRevision, withPlm, withRevision } from '../revisions';
import { approvalSchema, atSchema, bySchema, effectivitySchema } from '../params';

const ecnOf = (id: string): string => (id.startsWith('ECO-') ? `ECN-${id.slice(4)}` : `ECN-${id}`);

/**
 * @affects doc.plm (current revision in_review -> released with contentHash, inline snapshot, releasedAt/By, effectivity, approvals, unverified flags;
 *   the previously released revision -> superseded with its effectivity closed at the cut-in; the ECO -> implemented with its ECN)
 * @invariant contentHash = sha256 of the canonical release-scope bytes stored as the snapshot; the definition is unchanged by the release
 * @failure agent caller -> PLM_HUMAN_GATE; any readiness failure refuses with its own code (PLM_STATE_TRANSITION, PLM_ECO_*, PLM_APPROVALS_MISSING,
 *   PLM_CHECKER_IS_AUTHOR, PLM_EFFECTIVITY_*, PLM_MARKING_UNDECIDED, PLM_SIGNATURE_REQUIRED, PLM_PARAMETER_ERRORS); document unchanged
 */
export const releaseItem = defineCommand({
  name: 'release_item',
  description:
    'HUMAN GATE. Release the in_review revision: freezes its content (SHA-256 of the canonical definition + an inline snapshot), records approvals, change ' +
    'order and effectivity, supersedes the previously released revision (its open effectivity closes the day / serial before this one starts) and ' +
    'implements the ECO. Needs submit_for_review first, the policy roles approved (checker different from the author), an open ECO listing the item ' +
    '(after the first release) and, by default, a human approval signature (record_signature). check_release_readiness lists every blocker without ' +
    'changing anything. An agent caller gets PLM_HUMAN_GATE: prepare with check_release_readiness and hand over to the humans.',
  annotations: { destructive: true, metaHistory: true },
  params: z.object({
    changeOrder: z.string().optional().describe('The open ECO that authorizes this release (lists this item).'),
    effectivity: z.array(effectivitySchema).optional().describe("Effectivity of this revision; default: the ECO's planned effectivity."),
    approvals: z
      .array(approvalSchema)
      .optional()
      .describe('Approvals given with the release, on top of those already recorded (record_approval).'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'release_item', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanGateRefusal(doc, 'release_item', ctx, [plm.item.partNumber, plm.item.currentRevision]);
    if (gate !== null) return gate;
    const inputs = {
      ...(params.changeOrder !== undefined ? { changeOrder: params.changeOrder } : {}),
      ...(params.effectivity !== undefined ? { effectivity: params.effectivity } : {}),
      ...(params.approvals !== undefined ? { approvals: params.approvals } : {}),
    };
    const failure = releaseFindings(doc, plm, inputs).find((finding) => finding.severity === 'fail');
    if (failure !== undefined) return refusePlm(doc, 'release_item', failure.code as PlmCode, failure.message, failure.ids);
    const revision = currentRevisionOf(plm) as Revision;
    const eco = params.changeOrder !== undefined ? plm.changes[params.changeOrder] : undefined;
    const effectivity = plannedEffectivity(inputs, eco);
    const priors = plm.item.revisionOrder.flatMap((label) => {
      const prior = plm.item.revisions[label];
      return prior !== undefined && label !== revision.label && (prior.state === 'released' || prior.state === 'superseded')
        ? [{ label, effectivity: prior.effectivity }]
        : [];
    });
    const cut = closeForCutIn(priors, effectivity);
    const closed = 'closed' in cut ? cut.closed : {};
    const scope = scopeOf(doc, ctx);
    const { at, by } = params;
    const released: Revision = {
      ...revision,
      state: 'released',
      approvals: mergedApprovals(revision, params.approvals),
      effectivity,
      releasedEffectivity: effectivity,
      releasedMarking: plm.item.marking,
      ...(at !== undefined ? { releasedAt: at } : {}),
      ...(by !== undefined ? { releasedBy: by } : {}),
      ...(params.changeOrder !== undefined ? { changeOrder: params.changeOrder } : {}),
      contentHash: scope.sha256,
      snapshot: { kind: 'inline', canonicalJson: scope.canonicalJson },
      unverified: unverifiedInScope(doc),
      stateHistory: [...revision.stateHistory, stateChange('in_review', 'released', at, by)],
    };
    const revisions: Record<string, Revision> = { ...plm.item.revisions, [revision.label]: released };
    const superseded: string[] = [];
    for (const [label, ranges] of Object.entries(closed)) {
      const prior = revisions[label];
      if (prior === undefined) continue;
      const wasReleased = prior.state === 'released';
      if (wasReleased) superseded.push(label);
      revisions[label] = {
        ...prior,
        effectivity: ranges,
        ...(wasReleased
          ? {
              state: 'superseded' as const,
              stateHistory: [...prior.stateHistory, stateChange('released', 'superseded', at, by, `superseded by ${revision.label}`)],
            }
          : {}),
      };
    }
    const changes: Record<string, ChangeRecord> = { ...plm.changes };
    if (eco !== undefined && params.changeOrder !== undefined)
      changes[params.changeOrder] = { ...eco, state: 'implemented', notice: ecnOf(eco.id), ...(at !== undefined ? { closedAt: at } : {}) };
    const next: PlmModel = { ...plm, item: { ...plm.item, revisions }, changes };
    return changed(
      withPlm(doc, next),
      `${revisionText(plm)} released: content hash ${scope.sha256.slice(0, 12)}… (${scope.canonicalJson.length} bytes)` +
        `${superseded.length > 0 ? `; superseded ${superseded.join(', ')}` : ''}${eco !== undefined ? `; ${eco.id} implemented (${ecnOf(eco.id)})` : ''}.`,
      [],
    );
  },
});

/**
 * @affects doc.plm.item (adds revision next(scheme) in_work basedOn the current one with iteration 1, makes it current)
 * @invariant the previous revision object is unchanged (deep-equal)
 * @failure current revision not released -> PLM_STATE_TRANSITION; no open ECO listing the item (policy) -> PLM_ECO_REQUIRED; unknown / closed ECO ->
 *   PLM_ECO_UNKNOWN / PLM_ECO_CLOSED; scheme exhausted -> PLM_SCHEME_INVALID (refusals, unchanged doc)
 */
export const reviseItem = defineCommand({
  name: 'revise_item',
  description:
    'Open the next revision (B after A, per the scheme) of a RELEASED item under an open change order that lists it (policy.requireChangeOrder; with ' +
    'exactly one such ECO it is picked automatically). The new revision is in_work at iteration 1 and based on the current one, which stays released and ' +
    'unchanged. Then edit the model, submit_for_review and release_item. An agent may do this step.',
  annotations: { metaHistory: true },
  params: z.object({
    changeOrder: z.string().optional().describe('Open ECO listing this item. Default: the single open ECO listing it.'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, { changeOrder, at, by }, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'revise_item', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const current = currentRevisionOf(plm);
    if (current === undefined || current.state !== 'released')
      return refusePlm(
        doc,
        'revise_item',
        'PLM_STATE_TRANSITION',
        `${revisionText(plm)} is ${current?.state ?? 'missing'}; only a released revision can be revised`,
        [plm.item.partNumber],
      );
    const listing = Object.values(plm.changes).filter(
      (change) => change.kind === 'eco' && change.state === 'open' && change.affectedItems.includes(plm.item.partNumber),
    );
    let eco: ChangeRecord | undefined;
    if (changeOrder !== undefined) {
      eco = plm.changes[changeOrder];
      if (eco === undefined || eco.kind !== 'eco')
        return refusePlm(doc, 'revise_item', 'PLM_ECO_UNKNOWN', `unknown change order '${changeOrder}'`, [changeOrder]);
      if (eco.state !== 'open')
        return refusePlm(doc, 'revise_item', 'PLM_ECO_CLOSED', `${changeOrder} is ${eco.state}, not open`, [changeOrder]);
      if (!eco.affectedItems.includes(plm.item.partNumber))
        return refusePlm(doc, 'revise_item', 'PLM_ECO_REQUIRED', `${changeOrder} does not list ${plm.item.partNumber}`, [changeOrder]);
    } else if (listing.length === 1) eco = listing[0];
    if (eco === undefined && plm.policy.requireChangeOrder)
      return refusePlm(
        doc,
        'revise_item',
        'PLM_ECO_REQUIRED',
        'a released revision can only be revised under an open change order (policy.requireChangeOrder)',
        [plm.item.partNumber],
      );
    const label = revisionLabel(plm.item.revisionScheme, plm.item.revisionOrder.length + 1, plm.policy.customLabels);
    if (label === null || Object.hasOwn(plm.item.revisions, label))
      return refusePlm(
        doc,
        'revise_item',
        'PLM_SCHEME_INVALID',
        `scheme ${plm.item.revisionScheme} has no further revision label`,
        [plm.item.partNumber],
        ['revisionScheme'],
      );
    const revision = openRevision(label, scopeOf(doc, ctx).sha256, at, by, {
      basedOn: current.label,
      ...(eco !== undefined ? { changeOrder: eco.id } : {}),
    });
    const item = {
      ...plm.item,
      currentRevision: label,
      revisions: { ...plm.item.revisions, [label]: revision },
      revisionOrder: [...plm.item.revisionOrder, label],
    };
    return changed(
      withPlm(doc, { ...plm, item }),
      `${plm.item.partNumber}: revision ${label} opened in_work (iteration 1) based on ${current.label}${eco !== undefined ? ` under ${eco.id}` : ''}.`,
      [],
    );
  },
});

/**
 * @affects doc.plm.item.revisions[revision].state (obsolete | cancelled) and its stateHistory; content hash and snapshot unchanged
 * @invariant only transitions of the lifecycle table: released | superseded -> obsolete, in_work -> cancelled; obsolete / cancelled revisions never
 *   resolve by effectivity
 * @failure unknown revision -> PLM_REVISION_UNKNOWN; illegal transition -> PLM_STATE_TRANSITION; empty reason -> PLM_PARAM_INVALID; obsoleting a
 *   released revision without an open ECO (policy) -> PLM_ECO_REQUIRED (refusals, unchanged doc)
 */
export const setLifecycleState = defineCommand({
  name: 'set_lifecycle_state',
  description:
    'Retire a revision: released or superseded -> obsolete, in_work -> cancelled (an in_review revision needs reject_review first). A reason is ' +
    'mandatory; obsoleting a released revision also needs an open change order (policy.requireChangeOrder). The content hash and snapshot stay; ' +
    'obsolete and cancelled revisions no longer resolve by effectivity. Not reversible (terminal states).',
  annotations: { destructive: true, metaHistory: true },
  params: z.object({
    revision: z.string().describe('Revision label, e.g. "B".'),
    state: z.enum(['obsolete', 'cancelled']).describe("'obsolete' (released / superseded) or 'cancelled' (in_work, never released)."),
    reason: z.string().describe('Why (non-empty).'),
    changeOrder: z.string().optional().describe('Open ECO authorizing the obsolescence.'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, { revision: label, state, reason, changeOrder, at, by }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'set_lifecycle_state', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'set_lifecycle_state', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    if (!isLegalTransition(revision.state, state))
      return refusePlm(
        doc,
        'set_lifecycle_state',
        'PLM_STATE_TRANSITION',
        `${revisionText(plm, label)} is ${revision.state}; ${transitionRefusal(revision.state, state)}`,
        [plm.item.partNumber, label],
      );
    if (reason.trim() === '')
      return refusePlm(doc, 'set_lifecycle_state', 'PLM_PARAM_INVALID', 'a lifecycle change needs a reason', [], ['reason']);
    if (revision.state === 'released' && plm.policy.requireChangeOrder) {
      const eco = changeOrder === undefined ? undefined : plm.changes[changeOrder];
      if (eco === undefined || eco.state !== 'open')
        return refusePlm(
          doc,
          'set_lifecycle_state',
          'PLM_ECO_REQUIRED',
          `obsoleting a released revision needs an open change order (policy.requireChangeOrder)${changeOrder !== undefined ? `; '${changeOrder}' is not open` : ''}`,
          changeOrder === undefined ? [] : [changeOrder],
        );
    }
    const next: Revision = {
      ...revision,
      state,
      stateHistory: [...revision.stateHistory, stateChange(revision.state, state, at, by, reason)],
    };
    return changed(withRevision(doc, plm, label, next), `${revisionText(plm, label)} ${revision.state} -> ${state}: ${reason}`, []);
  },
});
