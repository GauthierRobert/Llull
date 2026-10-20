/** Change control (FR-PLM-08/09): change requests (ECR), change orders (ECO), their classification and closing. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { ChangeRecord, PlmModel } from '@core/model/plm';
import { effectivityProblem } from '../effectivity';
import { refusePlm } from '../refusal';
import { NOT_MANAGED } from '../state';
import { humanAct } from '../gate';
import { withPlm } from '../revisions';
import { atSchema, bySchema, confirmationSchema, dispositionSchema, effectivitySchema } from '../params';

const classificationSchema = z.enum(['minor', 'major']);
const tagsSchema = z
  .array(z.enum(['acoustical', 'emissions']))
  .describe('Optional 14 CFR 21.93(b)/(c) tags: acoustical or emissions changes.');

/** Next free id `<PREFIX>-nnnn` (4 digits, after every existing id of that prefix). */
function mintId(plm: PlmModel, prefix: 'ECR' | 'ECO'): string {
  const used = plm.changeOrder.filter((id) => id.startsWith(`${prefix}-`)).length;
  let n = used + 1;
  while (Object.hasOwn(plm.changes, `${prefix}-${String(n).padStart(4, '0')}`)) n += 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

const addChange = (doc: CadDocument, plm: PlmModel, record: ChangeRecord): CadDocument =>
  withPlm(doc, { ...plm, changes: { ...plm.changes, [record.id]: record }, changeOrder: [...plm.changeOrder, record.id] });

/** The unknown item numbers of `items` (the document's own managed item and its bound sub-items exist). */
const unknownItems = (plm: PlmModel, items: readonly string[]): string[] =>
  items.filter((pn) => pn !== plm.item.partNumber && plm.subItems?.[pn] === undefined);

/**
 * @affects doc.plm.changes[id] (adds an open ECR), doc.plm.changeOrder
 * @invariant ids are unique; the proposed classification is only a proposal (the ECO records the decision)
 * @failure not managed -> PLM_NOT_MANAGED; empty title / unknown item -> PLM_PARAM_INVALID; duplicate id -> PLM_ID_EXISTS
 */
export const createChangeRequest = defineCommand({
  name: 'create_change_request',
  description:
    'Open an engineering change request (ECR): title, reason, affected part numbers and an optional proposed minor / major classification (a proposal ' +
    'only). An agent may draft it. Next: a human creates the change order (create_change_order fromRequests).',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().optional().describe("Change request id; omitted = the next 'ECR-nnnn'."),
    title: z.string().describe('Short title (non-empty).'),
    reason: z.string().describe('Why the change is needed (e.g. the finding or stress note).'),
    affectedItems: z.array(z.string()).optional().describe("Affected part numbers. Default: this document's managed item."),
    proposedClassification: classificationSchema
      .optional()
      .describe('Proposed classification; the decision is recorded on the ECO by a human.'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'create_change_request', 'PLM_NOT_MANAGED', NOT_MANAGED);
    if (params.title.trim() === '')
      return refusePlm(doc, 'create_change_request', 'PLM_PARAM_INVALID', 'a change request needs a title', [], ['title']);
    const items = params.affectedItems ?? [plm.item.partNumber];
    const unknown = unknownItems(plm, items);
    if (unknown.length > 0)
      return refusePlm(
        doc,
        'create_change_request',
        'PLM_PARAM_INVALID',
        `unknown item(s) ${unknown.join(', ')}; this document manages ${plm.item.partNumber}`,
        unknown,
        ['affectedItems'],
      );
    const id = params.id ?? mintId(plm, 'ECR');
    if (Object.hasOwn(plm.changes, id))
      return refusePlm(doc, 'create_change_request', 'PLM_ID_EXISTS', `change '${id}' already exists`, [id]);
    const record: ChangeRecord = {
      id,
      kind: 'ecr',
      title: params.title,
      reason: params.reason,
      affectedItems: items,
      purpose: 'change',
      ...(params.proposedClassification !== undefined ? { proposedClassification: params.proposedClassification } : {}),
      state: 'open',
      createdAt: params.at ?? '',
      createdBy: params.by ?? '',
    };
    return changed(addChange(doc, plm, record), `Change request ${id} opened for ${items.join(', ')}: ${params.title}.`, []);
  },
});

/**
 * @affects doc.plm.changes[id] (adds an open ECO; listed ECRs become accepted), doc.plm.changeOrder
 * @invariant classification is never inferred: it is recorded only when the caller gives it, and only a human may (an agent can draft an unclassified ECO)
 * @failure unknown ECR -> PLM_ECO_UNKNOWN; ECR not open -> PLM_ECO_CLOSED; classification by an agent -> PLM_HUMAN_GATE; 'initial-release' after a release,
 *   bad effectivity, unknown item -> PLM_PARAM_INVALID / PLM_EFFECTIVITY_UNIT_TYPE; duplicate id -> PLM_ID_EXISTS (all refusals, unchanged doc)
 */
export const createChangeOrder = defineCommand({
  name: 'create_change_order',
  description:
    'Open an engineering change order (ECO) that authorizes releasing or revising the item. purpose "initial-release" (first release, nothing to classify) ' +
    'or "change" (default: a later revision; a human must record the minor / major classification with a justification, here or later with ' +
    'classify_change_order; release is refused without it). Listed ECRs (fromRequests) become accepted. Carries the planned effectivity and the ' +
    'disposition of in-stock / WIP / fielded parts. An agent may draft an ECO but gets PLM_HUMAN_GATE if it passes a classification.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().optional().describe("ECO id; omitted = the next 'ECO-nnnn'."),
    title: z.string().optional().describe('Short title; default derived from the purpose.'),
    purpose: z.enum(['initial-release', 'change']).optional().describe("'initial-release' or 'change' (default)."),
    fromRequests: z.array(z.string()).optional().describe('Open ECR ids this ECO implements; they become accepted.'),
    affectedItems: z.array(z.string()).optional().describe("Affected part numbers. Default: this document's managed item."),
    classification: classificationSchema.optional().describe('HUMAN: minor or major, decided by the applicant. Never inferred.'),
    classificationTags: tagsSchema.optional(),
    confirmation: confirmationSchema,
    classificationJustification: z.string().optional().describe('HUMAN: why that classification.'),
    effectivity: z
      .array(effectivitySchema)
      .optional()
      .describe('Planned effectivity of the new revision, e.g. [{ kind: "serial", from: 5 }].'),
    disposition: z
      .object({
        inStock: dispositionSchema.optional().describe('Disposition of parts in stock.'),
        wip: dispositionSchema.optional().describe('Disposition of work in progress.'),
        fielded: dispositionSchema.optional().describe('Disposition of fielded parts.'),
      })
      .optional()
      .describe('What happens to existing parts.'),
    at: atSchema.optional(),
    by: bySchema.optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'create_change_order', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const purpose = params.purpose ?? 'change';
    const requests = params.fromRequests ?? [];
    for (const id of requests) {
      const request = plm.changes[id];
      if (request === undefined || request.kind !== 'ecr')
        return refusePlm(doc, 'create_change_order', 'PLM_ECO_UNKNOWN', `unknown change request '${id}'`, [id], ['fromRequests']);
      if (request.state !== 'open')
        return refusePlm(
          doc,
          'create_change_order',
          'PLM_ECO_CLOSED',
          `change request '${id}' is ${request.state}, not open`,
          [id],
          ['fromRequests'],
        );
    }
    const items = params.affectedItems ?? [plm.item.partNumber];
    const unknown = unknownItems(plm, items);
    if (unknown.length > 0)
      return refusePlm(
        doc,
        'create_change_order',
        'PLM_PARAM_INVALID',
        `unknown item(s) ${unknown.join(', ')}; this document manages ${plm.item.partNumber}`,
        unknown,
        ['affectedItems'],
      );
    const everReleased = Object.values(plm.item.revisions).some(
      (revision) => revision.releasedAt !== undefined || revision.contentHash !== undefined,
    );
    if (purpose === 'initial-release' && everReleased)
      return refusePlm(
        doc,
        'create_change_order',
        'PLM_PARAM_INVALID',
        `${plm.item.partNumber} already has a released revision; use purpose 'change'`,
        [plm.item.partNumber],
        ['purpose'],
      );
    const problem = effectivityProblem(params.effectivity ?? []);
    if (problem !== null) return refusePlm(doc, 'create_change_order', 'PLM_EFFECTIVITY_UNIT_TYPE', problem, [], ['effectivity']);
    const classifies =
      params.classification !== undefined || params.classificationTags !== undefined || params.classificationJustification !== undefined;
    if (classifies) {
      const gate = humanAct(doc, 'create_change_order', params, ctx);
      if ('refusal' in gate) return gate.refusal;
    }
    const id = params.id ?? mintId(plm, 'ECO');
    if (Object.hasOwn(plm.changes, id))
      return refusePlm(doc, 'create_change_order', 'PLM_ID_EXISTS', `change '${id}' already exists`, [id]);
    const record: ChangeRecord = {
      id,
      kind: 'eco',
      title: params.title ?? (purpose === 'initial-release' ? `Initial release of ${items.join(', ')}` : `Change of ${items.join(', ')}`),
      affectedItems: items,
      purpose,
      ...(params.classification !== undefined ? { classification: params.classification } : {}),
      ...(params.classificationTags !== undefined ? { classificationTags: params.classificationTags } : {}),
      ...(params.classificationJustification !== undefined ? { classificationJustification: params.classificationJustification } : {}),
      ...(params.effectivity !== undefined ? { effectivity: params.effectivity } : {}),
      ...(params.disposition !== undefined ? { disposition: params.disposition } : {}),
      ...(requests.length > 0 ? { fromRequests: requests } : {}),
      state: 'open',
      createdAt: params.at ?? '',
      createdBy: params.by ?? '',
    };
    const accepted = Object.fromEntries(
      requests.map((request) => [request, { ...(plm.changes[request] as ChangeRecord), state: 'accepted' as const }]),
    );
    const next = addChange(doc, { ...plm, changes: { ...plm.changes, ...accepted } }, record);
    return changed(
      next,
      `Change order ${id} (${purpose}) opened for ${items.join(', ')}${requests.length > 0 ? `; accepted ${requests.join(', ')}` : ''}.`,
      [],
    );
  },
});

/**
 * @affects doc.plm.changes[id].classification, classificationTags, classificationJustification
 * @invariant a human decision: an agent caller is refused; only an open ECO can be classified
 * @failure agent caller -> PLM_HUMAN_GATE; unknown / not-open ECO -> PLM_ECO_UNKNOWN / PLM_ECO_CLOSED; empty justification -> PLM_PARAM_INVALID
 */
export const classifyChangeOrder = defineCommand({
  name: 'classify_change_order',
  description:
    "HUMAN GATE. Record the minor / major classification (with a justification) of an open ECO. It is the applicant's decision: llull shows nothing " +
    'and infers nothing. An agent caller gets PLM_HUMAN_GATE. A "change" ECO needs it before release_item.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().describe('The ECO id.'),
    classification: classificationSchema.describe('minor or major.'),
    justification: z.string().describe('Why (non-empty).'),
    tags: tagsSchema.optional(),
    confirmation: confirmationSchema,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, classification, justification, tags } = params;
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'classify_change_order', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanAct(doc, 'classify_change_order', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const record = plm.changes[id];
    if (record === undefined || record.kind !== 'eco')
      return refusePlm(doc, 'classify_change_order', 'PLM_ECO_UNKNOWN', `unknown change order '${id}'`, [id], ['id']);
    if (record.state !== 'open')
      return refusePlm(doc, 'classify_change_order', 'PLM_ECO_CLOSED', `${id} is ${record.state}, not open`, [id]);
    if (justification.trim() === '')
      return refusePlm(
        doc,
        'classify_change_order',
        'PLM_PARAM_INVALID',
        'a classification needs a justification',
        [id],
        ['justification'],
      );
    const next: ChangeRecord = {
      ...record,
      classification,
      classificationJustification: justification,
      ...(tags !== undefined ? { classificationTags: tags } : {}),
    };
    return changed(
      withPlm(doc, { ...plm, changes: { ...plm.changes, [id]: next } }),
      `${id} classified ${classification}: ${justification}`,
      [],
    );
  },
});

/**
 * @affects doc.plm.changes[id].state (rejected | cancelled), closedAt
 * @invariant implemented is terminal; only open (and, for an ECR, accepted) records close
 * @failure agent caller -> PLM_HUMAN_GATE; unknown id -> PLM_ECO_UNKNOWN; a closed record -> PLM_STATE_TRANSITION (refusals, unchanged doc)
 */
export const setChangeState = defineCommand({
  name: 'set_change_state',
  description:
    'HUMAN GATE. Close an ECR or ECO as rejected or cancelled, with a reason. Implemented records are terminal. An agent caller gets PLM_HUMAN_GATE.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().describe('ECR or ECO id.'),
    state: z.enum(['rejected', 'cancelled']).describe('The closing state.'),
    reason: z.string().describe('Why (non-empty).'),
    at: atSchema.optional(),
    by: bySchema.optional(),
    confirmation: confirmationSchema,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, state, reason, at } = params;
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'set_change_state', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanAct(doc, 'set_change_state', params, ctx);
    if ('refusal' in gate) return gate.refusal;
    const record = plm.changes[id];
    if (record === undefined) return refusePlm(doc, 'set_change_state', 'PLM_ECO_UNKNOWN', `unknown change '${id}'`, [id], ['id']);
    if (reason.trim() === '')
      return refusePlm(doc, 'set_change_state', 'PLM_PARAM_INVALID', 'closing a change needs a reason', [id], ['reason']);
    const closable = record.state === 'open' || (record.kind === 'ecr' && record.state === 'accepted');
    if (!closable)
      return refusePlm(doc, 'set_change_state', 'PLM_STATE_TRANSITION', `${id} is ${record.state}; only an open change closes`, [id]);
    const next: ChangeRecord = { ...record, state, ...(at !== undefined ? { closedAt: at } : {}) };
    return changed(
      withPlm(doc, { ...plm, changes: { ...plm.changes, [id]: next } }),
      `${record.kind.toUpperCase()} ${id} ${state}: ${reason}`,
      [],
    );
  },
});
