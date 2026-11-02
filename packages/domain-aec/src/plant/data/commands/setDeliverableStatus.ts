import { changed } from '@core/commands/noop';
import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { atLeast, checkFindings } from '../check';
import { deliverableContent } from '../deliverableContent';
import { allowedTargets, currentStatus, withStep } from '../deliverables';
import { pathOf, resolveNode } from '../hierarchy';
import { DELIVERABLE_STATUSES, getPlantData, HUMAN_GATED_STATUSES, own, withPlantData, type DeliverableStatus } from '../model';
import { refuse } from './params';

const SETTABLE = DELIVERABLE_STATUSES.filter((status): status is Exclude<DeliverableStatus, 'superseded'> => status !== 'superseded');
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REVIEW_REASON = 'computed by llull, not approved: needs a qualified engineer';

/**
 * @affects plant.data.deliverables[deliverable].revisions (+1 step on one revision; older issued revisions of a lower or equal status get a superseded step); metaHistory: no feature step, the slice is carried across a history replay
 * @invariant `at` is host-filled and signed; the three signed statuses need a signature verified AND spent by ctx.humanSignature over { act, deliverable, revision, from, status, content hash, scope }, checked after the transition, the content and the check so a refusal never spends it; one step forward at a time; an agent may set in_work and issued_for_review only; a stored signed step is never replayed
 * @failure unknown deliverable / hierarchy / changed scope -> DAT_PARAM_INVALID, DAT_HIERARCHY_UNKNOWN; illegal transition -> DAT_STATUS_TRANSITION; check_plant_data fail in scope -> DAT_CHECK_FAILED; no valid human signature -> DAT_HUMAN_GATE; document unchanged
 */
export const setDeliverableStatus = defineCommand({
  name: 'set_deliverable_status',
  description:
    'Move a revision of a plant deliverable through its issue states, recording the SHA-256 of the content at that moment. deliverable: line_list, equipment_list, nozzle_schedule, valve_list, instrument_index, mto, tag_register, ifc (the ' +
    'IFC4X3_ADD2 export) or the id of a report saved with save_report_definition. revision: your label ("A", "0"); a revision is created by its first status. ' +
    'Order: in_work, issued_for_review, issued_for_approval, issued_for_construction, as_built; one step forward at a time (a new revision may start at in_work or issued_for_review). ' +
    'An agent may set in_work and issued_for_review. issued_for_approval, issued_for_construction and as_built are HUMAN acts: `confirmation` must be a signature object produced by a human in the desktop app ' +
    '(with a nonce field) over the act, the deliverable, the revision, the previous status, the new status, the content hash, the scope and `at`, verified and spent once by the signing port; ' +
    'and check_plant_data must report no failing finding for the deliverable scope (checked first, so a signature is not spent on a refusal). hierarchy scopes a report deliverable to a node (code, path or id) when ' +
    'its revision is created; later steps keep that scope. Issuing a revision supersedes older revisions of the same deliverable that are issued at the same or a lower status (a review issue never retires an approval). ' +
    'Every step stores `at` (host-filled) and a signed step also stores the signer, the signature id and the payload hash that was signed. The status is NOT a lock on the content: edit the plant afterwards and the stored hash no longer matches (export_handover document register reports contentCurrent). ' +
    'This is a document-state command, not a recipe step: a history replay keeps the deliverables and never re-runs a signature. Returns data = { deliverable, revision, status, from, contentSha256, hierarchy, signer?, signatureId?, payloadSha256?, at, superseded[], checkWarnings (null when no check ran), reviewRequired, reviewReason? }; ' +
    'reviewRequired is true until a signed status is reached. Refusals (document unchanged): DAT_PARAM_INVALID, DAT_HIERARCHY_UNKNOWN, DAT_STATUS_TRANSITION, DAT_CHECK_FAILED, DAT_HUMAN_GATE.',
  annotations: { metaHistory: true },
  params: z.object({
    confirmExportControlled,
    deliverable: z
      .string()
      .min(1)
      .describe(
        'line_list, equipment_list, nozzle_schedule, valve_list, instrument_index, mto, tag_register, ifc, or a saved report definition id.',
      ),
    revision: z.string().trim().min(1).max(64).describe('Revision label, e.g. "A" or "0". Created by its first status.'),
    status: z
      .enum(SETTABLE)
      .describe('The status to move to: the next one in order. superseded is set by a newer revision, never by hand.'),
    hierarchy: z
      .string()
      .optional()
      .describe(
        'Scope of a report deliverable (hierarchy node code, path S1/P1/U10 or id), given when the revision is created; omit for the whole plant. Not allowed for ifc.',
      ),
    at: z
      .string()
      .regex(ISO_UTC, 'must be ISO-8601 UTC like 2026-11-02T09:30:00Z')
      .describe(
        'When the step happened: ISO-8601 UTC, e.g. 2026-11-02T09:30:00Z. The host (UI / llull CLI) fills it and overwrites a caller value; commands never read a clock. Part of what a human signs.',
      ),
    confirmation: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Human confirmation for issued_for_approval, issued_for_construction and as_built: a signature object (with a nonce field) produced in the desktop app over this act. An agent cannot give it: true or a missing value is refused with DAT_HUMAN_GATE.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const data = getPlantData(doc);
    const fail = (code: string, message: string, paths: readonly string[], ids: readonly string[] = []): CommandResult =>
      refuse(doc, 'set_deliverable_status', { code, message, paths, ids });
    const existing = own(data.deliverables, params.deliverable);
    const known = existing?.revisions.find((revision) => revision.label === params.revision);
    const from = known === undefined ? null : currentStatus(known);
    const allowed = allowedTargets(from);
    if (!allowed.includes(params.status))
      return fail(
        'DAT_STATUS_TRANSITION',
        `${from === null ? 'a new revision' : `revision ${params.revision} (${from})`} cannot move to ${params.status}; allowed: ${allowed.join(', ') || 'none (final state)'}`,
        ['status'],
      );
    let scope = params.hierarchy;
    const fixed = known !== undefined;
    if (known !== undefined) {
      const given = params.hierarchy === undefined ? undefined : resolveNode(data, params.hierarchy);
      if (params.hierarchy !== undefined && (given === null || given === 'ambiguous' || given?.id !== known.hierarchyId))
        return fail(
          'DAT_PARAM_INVALID',
          `revision ${params.revision} is scoped to ${known.hierarchyId === undefined ? 'the whole plant' : own(data.hierarchy, known.hierarchyId) === undefined ? `${known.hierarchyId} (missing)` : pathOf(data, known.hierarchyId)}: its scope cannot change`,
          ['hierarchy'],
        );
      scope = known.hierarchyId;
    }
    const built = deliverableContent(doc, params.deliverable, { hierarchy: scope, fixed }, ctx, params.confirmExportControlled);
    if (!built.ok) return fail(built.code, built.message, built.paths ?? []);
    const { content } = built;
    const gated = HUMAN_GATED_STATUSES.includes(params.status);
    const findings = gated ? checkFindings(doc, content.objects === undefined ? {} : { objects: content.objects }) : [];
    const failing = atLeast(findings, 'fail');
    if (failing.length > 0)
      return fail(
        'DAT_CHECK_FAILED',
        `check_plant_data reports ${failing.length} failing finding(s) for ${params.deliverable}: ${[...new Set(failing.map((finding) => finding.code))].join(', ')}`,
        ['deliverable'],
        [...new Set(failing.flatMap((finding) => finding.ids))],
      );
    let signed: { readonly signer: string; readonly signatureId: string; readonly payloadSha256: string } | null = null;
    if (gated) {
      const details = {
        revision: params.revision,
        from,
        status: params.status,
        contentSha256: content.sha256,
        hierarchyId: content.hierarchyId ?? null,
        at: params.at,
      };
      const outcome = humanGate(
        ctx?.humanSignature ?? null,
        'plant:set_deliverable_status',
        [params.deliverable],
        params.confirmation,
        details,
      );
      if (!outcome.cleared)
        return fail('DAT_HUMAN_GATE', `set_deliverable_status to ${params.status} is a human act: ${outcome.reason}`, ['confirmation']);
      const nonce = (params.confirmation as { nonce: string }).nonce;
      signed = {
        signer: outcome.signer,
        signatureId: outcome.signatureId,
        payloadSha256: humanGatePayload('plant:set_deliverable_status', [params.deliverable], details, nonce),
      };
    }
    const { deliverable, superseded } = withStep(existing, params.deliverable, params.revision, content.hierarchyId, {
      status: params.status,
      contentSha256: content.sha256,
      at: params.at,
      ...(signed ?? {}),
    });
    const next = withPlantData(doc, { ...data, deliverables: { ...data.deliverables, [params.deliverable]: deliverable } });
    return {
      ...changed(
        next,
        `set_deliverable_status: ${params.deliverable} revision ${params.revision} ${from ?? 'new'} -> ${params.status}, content ${content.sha256.slice(0, 12)}` +
          (signed === null ? '' : `, signed by ${signed.signer} (${signed.signatureId})`) +
          (superseded.length === 0 ? '' : `; superseded ${superseded.join(', ')}`) +
          (signed === null ? '; reviewRequired: ' + REVIEW_REASON + '.' : '.'),
        [`${params.deliverable}/${params.revision}`],
      ),
      data: {
        deliverable: params.deliverable,
        revision: params.revision,
        status: params.status,
        from,
        contentSha256: content.sha256,
        hierarchy: content.hierarchyId === undefined ? null : pathOf(data, content.hierarchyId),
        ...(signed ?? {}),
        superseded,
        checkWarnings: gated ? findings.filter((finding) => finding.severity === 'warn').length : null,
        reviewRequired: signed === null,
        ...(signed === null ? { reviewReason: REVIEW_REASON } : {}),
      },
    };
  },
});
