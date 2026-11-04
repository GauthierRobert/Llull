/** `approve_pipe_spec` (plant 01 PSC M3): the human gate that turns a draft spec revision into an approved one. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { humanGate } from '@core/model/humanGate';
import { withDocumentUid } from '@core/model/documentUid';
import { isRecord } from '@lib/isRecord';
import { sha256Hex } from '@lib/sha256';
import { elementsOf, getBuilding } from '../../../building/model';
import { isoUtc } from '../../../shared/isoUtc';
import { refuse } from '../../catalog/codes';
import { checkSpec } from '../checks/run';
import { canonicalSpecText } from '../file';
import { findSpec, getSpecModel, specRevisions, withSpecModel } from '../store';
import type { SpecApproval } from '../types';

/** The recorded form of a confirmation (`withoutConfirmations`): exactly { verified: true }. */
const isRecorded = (confirmation: unknown): boolean =>
  isRecord(confirmation) && Object.keys(confirmation).length === 1 && confirmation['verified'] === true;

const approvalOf = (outcome: { signer: string; signatureId: string; at: string }): SpecApproval => ({
  signer: outcome.signer,
  signatureId: outcome.signatureId,
  at: outcome.at,
});

/**
 * @affects plant.spec.specs[specId]: the revision becomes approved with approval { signer, signatureId, at }; earlier approved revisions become superseded
 * @invariant replay: the recorded step carries confirmation { verified: true } (the signature is never recorded); it is honoured only while the history replay machinery re-runs the step (ctx.replaying, never a param: a direct call with { verified: true } is PSC_HUMAN_GATE) and only for content that a verified human approval in the document's approval ledger already covers (same spec, revision and content hash), so replay_history / regenerate re-apply a real approval and nothing else;
 * a human act: confirmation is a signature verified by the signing port over { act plant:approve_pipe_spec, specId, revision, sha256 of the canonical spec } and spent once; an agent, a bare true or a signature for other content never approves; check_pipe_spec fail items are refused before any signature is spent; pipes on older revisions are reported stale, not changed
 * @failure unknown spec / revision -> PSC_SPEC_UNKNOWN; not a draft -> PSC_SPEC_INVALID; fail findings -> PSC_SPEC_CHECK_FAILED; no valid human signature -> PSC_HUMAN_GATE; the document is unchanged
 */
export const approvePipeSpec = defineCommand({
  name: 'approve_pipe_spec',
  description:
    'Approve a draft piping spec revision: a HUMAN act that an agent cannot perform (a qualified reviewer approves the spec). The spec must have no fail finding in check_pipe_spec (checked first, so a signature is not spent on a spec that cannot be approved); ' +
    'then `confirmation` must be a signature object produced by a human in the desktop app (with a nonce field) over the act, the spec id, the revision and the content hash of the spec, verified by the signing port. ' +
    'On success the revision is approved (status approved, approval { signer, signatureId, at }), earlier approved revisions become superseded, and pipes still bound to an older revision are listed as stale ' +
    '(data.stalePipes, PSC_SPEC_REVISION_STALE): assign_pipe_spec without a size moves them to this revision. Any later edit makes a new draft revision. ' +
    'Refusals (document unchanged): PSC_SPEC_UNKNOWN, PSC_SPEC_INVALID (not a draft), PSC_SPEC_CHECK_FAILED, PSC_HUMAN_GATE (an agent, true, no signing port, a signature that does not verify). ' +
    'Returns data { specId, revision, status, signer, signatureId, superseded, stalePipes, contentSha256 }.',
  params: z.object({
    specId: z.string().min(1).describe('Spec id (list_pipe_specs).'),
    revision: z.number().int().positive().describe('Draft revision to approve. Default: the newest.').optional(),
    confirmation: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Human confirmation: a signature object (with a nonce field) produced in the desktop app over the approve act. An agent cannot give it: true or a missing value is refused with PSC_HUMAN_GATE.',
      ),
    at: isoUtc.describe(
      'When the approval happened: ISO-8601 UTC, e.g. 2026-11-02T09:30:00Z. The host (UI / llull CLI) fills it; commands never read a clock.',
    ),
  }),
  run: (doc, { specId, revision, confirmation, at }, ctx): CommandResult => {
    const spec = findSpec(doc, specId, revision);
    if (spec === undefined)
      return refuse(
        doc,
        'approve_pipe_spec',
        'PSC_SPEC_UNKNOWN',
        `no spec "${specId}"${revision === undefined ? '' : ` revision ${revision}`} (specs in this document: ${getSpecModel(doc).specOrder.join(', ') || 'none'})`,
        [specId],
        ['specId'],
      );
    if (spec.status !== 'draft')
      return spec.status === 'approved' && revision === undefined
        ? report(doc, `approve_pipe_spec: spec ${specId} r${spec.revision} is already approved; nothing changed.`, {
            specId,
            revision: spec.revision,
            status: 'approved',
            unchanged: true,
          })
        : refuse(
            doc,
            'approve_pipe_spec',
            'PSC_SPEC_INVALID',
            `spec ${specId} r${spec.revision} is ${spec.status}, not a draft: edit it (edit_pipe_spec) to make a new draft revision`,
            [specId],
            ['revision'],
          );
    const fails = checkSpec(doc, spec, undefined).findings.filter((entry) => entry.status === 'fail');
    if (fails.length > 0)
      return refuse(
        doc,
        'approve_pipe_spec',
        'PSC_SPEC_CHECK_FAILED',
        `spec ${specId} r${spec.revision} has ${fails.length} fail finding(s): ${[...new Set(fails.map((entry) => entry.code))].join(', ')}`,
        [...new Set(fails.flatMap((entry) => entry.ids))],
        ['specId'],
      );
    const contentSha256 = sha256Hex(canonicalSpecText(spec));
    const recorded =
      ctx?.replaying === true && isRecorded(confirmation)
        ? getSpecModel(doc).approvals?.find(
            (entry) => entry.specId === specId && entry.revision === spec.revision && entry.contentSha256 === contentSha256,
          )
        : undefined;
    const outcome: { cleared: true; signer: string; signatureId: string; at: string } | { cleared: false; reason: string } =
      recorded !== undefined
        ? { cleared: true, signer: recorded.signer, signatureId: recorded.signatureId, at: recorded.at }
        : (() => {
            const gate = humanGate(
              ctx?.humanSignature ?? null,
              'plant:approve_pipe_spec',
              [specId],
              confirmation,
              withDocumentUid({ revision: spec.revision, contentSha256 }, doc),
            );
            return gate.cleared ? { ...gate, at } : gate;
          })();
    if (!outcome.cleared)
      return refuse(
        doc,
        'approve_pipe_spec',
        'PSC_HUMAN_GATE',
        `approve_pipe_spec is a human act: ${outcome.reason}`,
        [specId],
        ['confirmation'],
      );
    const model = getSpecModel(doc);
    const revisions = specRevisions(doc, specId) ?? [];
    const superseded = revisions.filter((entry) => entry.status === 'approved').map((entry) => entry.revision);
    const approved = { ...spec, status: 'approved' as const, approval: approvalOf(outcome) };
    const next = revisions.map((entry) =>
      entry.revision === spec.revision ? approved : entry.status === 'approved' ? { ...entry, status: 'superseded' as const } : entry,
    );
    const stalePipes = elementsOf(getBuilding(doc), 'pipe')
      .filter((pipe) => pipe.spec?.specId === specId && pipe.spec.revision !== spec.revision)
      .map((pipe) => pipe.id);
    return {
      document: withSpecModel(doc, {
        ...model,
        specs: { ...model.specs, [specId]: next },
        ...(recorded !== undefined
          ? model.approvals === undefined
            ? {}
            : { approvals: model.approvals }
          : { approvals: [...(model.approvals ?? []), { ...approvalOf(outcome), specId, revision: spec.revision, contentSha256 }] }),
      }),
      summary: `approve_pipe_spec: spec ${specId} r${spec.revision} approved by ${outcome.signer} (signature ${outcome.signatureId})${superseded.length === 0 ? '' : `; superseded r${superseded.join(', r')}`}${stalePipes.length === 0 ? '' : `; ${stalePipes.length} pipe(s) on older revisions are stale (PSC_SPEC_REVISION_STALE): assign_pipe_spec`}.`,
      affected: [],
      data: {
        specId,
        revision: spec.revision,
        status: 'approved',
        signer: outcome.signer,
        signatureId: outcome.signatureId,
        superseded,
        stalePipes,
        contentSha256,
      },
    };
  },
});
