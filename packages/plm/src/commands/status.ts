/** Read-only PLM queries: plm_status, check_release_readiness, resolve_effectivity, release_manifest, view_revision (FR-PLM-12/34/36). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { PlmModel, PlmPolicy, Revision } from '@core/model/plm';
import { resolveRevision, isUnitOfKind } from '../effectivity';
import { integrityOf } from '../integrity';
import { iterationManifest, releaseManifest } from '../manifest';
import { type Finding, releaseFindings, unverifiedInScope } from '../readiness';
import { refusePlm } from '../refusal';
import { DEFAULT_POLICY, NOT_MANAGED, currentRevisionOf, isDirty, revisionText } from '../state';
import { effectivitySchema } from '../params';
import { actParts, actPayload } from '../gate';

const NEXT: Readonly<Record<Revision['state'], string>> = {
  in_work: 'Nobody yet: submit_for_review when the definition is ready (an agent may do it).',
  in_review: 'The approving roles record_approval (and sign), then a human runs release_item.',
  released: 'None: revise_item under an open change order to change it.',
  superseded: 'None: a later revision is in effect.',
  obsolete: 'None: terminal.',
  cancelled: 'None: terminal.',
};

/** Policy as `{ value, source, defaulted }` per key (FR-PLM-36). */
function policyReport(policy: PlmPolicy): Record<string, { value: unknown; source: string; defaulted: boolean }> {
  const entries = Object.entries(policy).map(([key, value]) => {
    const fallback = (DEFAULT_POLICY as unknown as Record<string, unknown>)[key];
    const defaulted = JSON.stringify(value) === JSON.stringify(fallback);
    return [key, { value, source: defaulted ? 'llull default' : 'document policy', defaulted }];
  });
  return Object.fromEntries(entries);
}

const statusWord = (findings: readonly Finding[]): 'pass' | 'warn' | 'fail' =>
  findings.some((finding) => finding.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';

/** The humans a release still needs, in plain language (AF-36). */
function humanActions(plm: PlmModel, findings: readonly Finding[]): { role: string; act: string }[] {
  const actions: { role: string; act: string }[] = [];
  for (const found of findings) {
    if (found.code === 'PLM_APPROVALS_MISSING') for (const role of found.ids) actions.push({ role, act: 'record_approval' });
    if (found.code === 'PLM_SIGNATURE_REQUIRED')
      actions.push({ role: 'approver', act: 'sign the iteration (Approve & sign), then record_signature' });
    if (found.code === 'PLM_CLASSIFICATION_MISSING')
      actions.push({ role: 'applicant', act: 'classify_change_order (minor / major with justification)' });
    if (found.code === 'PLM_MARKING_UNDECIDED') actions.push({ role: 'export-control officer', act: 'set_item_marking' });
  }
  if (plm.item.revisions[plm.item.currentRevision]?.state === 'in_review') actions.push({ role: 'design-authority', act: 'release_item' });
  return actions;
}

/**
 * @affects nothing (read-only)
 * @invariant integrity and dirty are recomputed on every call; nothing derived is stored
 */
export const plmStatus = defineCommand({
  name: 'plm_status',
  description:
    'Report the configuration-management status of this document: managed item, revisions (state, iterations, content hash, effectivity), open ECR / ECO, ' +
    'whether the definition is dirty since the last checkpoint, integrity of released revisions (recomputed hashes: ok / mismatch), policy with defaults ' +
    'named, unverified inputs and `nextHumanAction` in plain language. Read-only.',
  annotations: { readOnly: true },
  params: z.object({}),
  run: (doc, _params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return report(doc, `plm_status: ${NOT_MANAGED}; set_item_identity makes it one.`, { managed: false });
    const revision = currentRevisionOf(plm);
    const unverified = unverifiedInScope(doc);
    const data = {
      managed: true,
      item: {
        partNumber: plm.item.partNumber,
        name: plm.item.name,
        itemType: plm.item.itemType,
        revisionScheme: plm.item.revisionScheme,
        currentRevision: plm.item.currentRevision,
        marking: plm.item.marking,
      },
      revisions: plm.item.revisionOrder.map((label) => {
        const found = plm.item.revisions[label] as Revision;
        return {
          label,
          state: found.state,
          iterations: found.iterations.length,
          contentHash: found.contentHash ?? null,
          effectivity: found.effectivity,
          basedOn: found.basedOn ?? null,
        };
      }),
      openChanges: plm.changeOrder.flatMap((id) => {
        const change = plm.changes[id];
        return change !== undefined && (change.state === 'open' || change.state === 'accepted')
          ? [{ id, kind: change.kind, state: change.state, title: change.title }]
          : [];
      }),
      dirty: revision?.state === 'in_work' ? isDirty(doc, plm, ctx) : false,
      integrity: integrityOf(doc, plm, ctx),
      policy: policyReport(plm.policy),
      reviewRequired: [] as string[],
      unverified,
      nextHumanAction: revision === undefined ? 'none' : NEXT[revision.state],
    };
    const bad = Object.entries(data.integrity)
      .filter(([, status]) => status === 'mismatch')
      .map(([label]) => label);
    return report(
      doc,
      `${revisionText(plm)} is ${revision?.state ?? 'missing'} (${data.revisions.length} revision(s), ${data.openChanges.length} open change(s))` +
        `${data.dirty ? '; definition changed since the last checkpoint' : ''}${bad.length > 0 ? `; INTEGRITY MISMATCH on ${bad.join(', ')}` : ''}.`,
      data,
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant lists every reason release_item would refuse (fail) and every flag that travels into the manifest (warn); never mutates
 */
export const checkReleaseReadiness = defineCommand({
  name: 'check_release_readiness',
  description:
    'Check, without changing anything, whether the current revision can be released now. Returns status pass | warn | fail, coded findings ' +
    '{ code, severity, ids, message, remediation } (state, ECO, approvals, checker independence, effectivity, marking, signature, parameter errors, ' +
    'unverified inputs, title block) and humanActionsNeeded naming who must act. Pass the changeOrder / effectivity / approvals you plan to give to ' +
    'release_item to evaluate them. Read-only; an agent should run this before handing a release to the humans.',
  annotations: { readOnly: true },
  params: z.object({
    changeOrder: z.string().optional().describe('The ECO you plan to release under.'),
    effectivity: z.array(effectivitySchema).optional().describe('The effectivity you plan to set (default: the ECO plan).'),
  }),
  run: (doc, { changeOrder, effectivity }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'check_release_readiness', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const findings = releaseFindings(doc, plm, {
      ...(changeOrder !== undefined ? { changeOrder } : {}),
      ...(effectivity !== undefined ? { effectivity } : {}),
    });
    const status = statusWord(findings);
    return report(
      doc,
      `${revisionText(plm)} release readiness: ${status} (${findings.filter((f) => f.severity === 'fail').length} blocker(s), ${findings.filter((f) => f.severity === 'warn').length} warning(s)).`,
      { status, findings, humanActionsNeeded: humanActions(plm, findings) },
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant the first released / superseded revision whose range of that kind contains the unit; obsolete / cancelled never resolve
 */
export const resolveEffectivity = defineCommand({
  name: 'resolve_effectivity',
  description:
    'Which released revision applies to a unit: `kind` serial | msn (positive integer unit), date (YYYY-MM-DD) or lot (id). Returns data { revision | null, state }. ' +
    'Obsolete and cancelled revisions never resolve. Read-only.',
  annotations: { readOnly: true },
  params: z.object({
    partNumber: z.string().optional().describe("Part number; default and only supported: this document's item."),
    kind: z.enum(['serial', 'msn', 'date', 'lot']).describe('Effectivity kind.'),
    unit: z.union([z.number(), z.string()]).describe('The unit: serial / MSN integer, date string, lot id.'),
  }),
  run: (doc, { partNumber, kind, unit }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'resolve_effectivity', 'PLM_NOT_MANAGED', NOT_MANAGED);
    if (partNumber !== undefined && partNumber !== plm.item.partNumber)
      return refusePlm(
        doc,
        'resolve_effectivity',
        'PLM_PARAM_INVALID',
        `unknown item '${partNumber}'; this document manages ${plm.item.partNumber}`,
        [partNumber],
        ['partNumber'],
      );
    if (!isUnitOfKind(kind, unit))
      return refusePlm(
        doc,
        'resolve_effectivity',
        'PLM_EFFECTIVITY_UNIT_TYPE',
        `${JSON.stringify(unit)} is not a valid ${kind} unit`,
        [],
        ['unit'],
      );
    const label = resolveRevision(plm.item, kind, unit);
    const state = label === null ? null : (plm.item.revisions[label]?.state ?? null);
    return report(
      doc,
      `${plm.item.partNumber} ${kind} ${String(unit)} -> ${label === null ? 'no effective revision' : `rev ${label} (${state})`}.`,
      { revision: label, state },
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant deterministic bytes: `canonical` is the exact text that is signed, `sha256` its hash
 */
export const releaseManifestQuery = defineCommand({
  name: 'release_manifest',
  description:
    'The canonical manifest of a frozen revision (kind "release": released / superseded / obsolete) or of an iteration of the revision (kind "iteration": ' +
    'what an approver signs before release). Returns data { body, canonical, sha256 }: `canonical` is the exact UTF-8 text a human signs (Ed25519) with ' +
    'the host key store, then record_signature. Read-only; deterministic.',
  annotations: { readOnly: true },
  params: z.object({
    revision: z.string().describe('Revision label, e.g. "A".'),
    kind: z.enum(['release', 'iteration']).optional().describe("'release' (default) or 'iteration' (the revision's current iteration)."),
    meaning: z
      .enum(['authorship', 'review', 'approval', 'release'])
      .optional()
      .describe(
        "What the signer will attest; it is part of the signed bytes. Default 'release' (kind release) or 'approval' (kind iteration).",
      ),
  }),
  run: (doc, { revision: label, kind = 'release', meaning }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'release_manifest', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'release_manifest', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    if (kind === 'release' && revision.contentHash === undefined)
      return refusePlm(doc, 'release_manifest', 'PLM_NOT_RELEASED', `${revisionText(plm, label)} is ${revision.state}, not released`, [
        label,
      ]);
    const manifest =
      kind === 'release'
        ? releaseManifest(plm, revision, meaning ?? 'release')
        : iterationManifest(plm, revision, revision.iterations.length, meaning ?? 'approval');
    if (manifest === null) return refusePlm(doc, 'release_manifest', 'PLM_NOT_RELEASED', `no ${kind} manifest for ${label}`, [label]);
    return report(doc, `${revisionText(plm, label)} ${kind} manifest: sha256 ${manifest.sha256} (${manifest.canonical.length} bytes).`, {
      body: manifest.body,
      canonical: manifest.canonical,
      sha256: manifest.sha256,
    });
  },
});

/**
 * @affects nothing (read-only)
 * @invariant returns the frozen definition exactly as released
 */
export const viewRevision = defineCommand({
  name: 'view_revision',
  description:
    'Return the frozen definition (llull-document envelope as data) of a released, superseded or obsolete revision, for read-only viewing and diffing. ' +
    'Large. Read-only: it never loads the snapshot into the working document (restore_revision_snapshot does).',
  annotations: { readOnly: true },
  params: z.object({ revision: z.string().describe('Revision label, e.g. "A".') }),
  run: (doc, { revision: label }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'view_revision', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'view_revision', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    if (revision.snapshot === undefined)
      return refusePlm(doc, 'view_revision', 'PLM_NO_SNAPSHOT', `${revisionText(plm, label)} (${revision.state}) has no release snapshot`, [
        label,
      ]);
    return report(
      doc,
      `${revisionText(plm, label)} snapshot: ${revision.snapshot.canonicalJson.length} bytes.`,
      JSON.parse(revision.snapshot.canonicalJson) as unknown,
    );
  },
});

/** The human-only PLM commands: each needs a `confirmation` signed over its own payload. */
export const GATED_COMMANDS = [
  'set_item_identity',
  'set_item_marking',
  'record_approval',
  'release_item',
  'create_change_order',
  'classify_change_order',
  'set_change_state',
  'set_lifecycle_state',
  'attach_release_package',
] as const;

/**
 * @affects nothing (read-only)
 * @invariant the hash binds the act, the item, the CURRENT PLM state hash, the params (without confirmation / at / by) and the signer-chosen nonce
 */
export const plmActPayload = defineCommand({
  name: 'plm_act_payload',
  description:
    'The SHA-256 a human signs to authorize one human-only PLM act (set_item_identity with policy, set_item_marking, record_approval, release_item, ' +
    'create_change_order with a classification, classify_change_order, set_change_state, set_lifecycle_state to obsolete, attach_release_package): ' +
    'pass the command, the params you will send (without confirmation) and a fresh nonce. The signature (Ed25519 over the UTF-8 hex hash, prefixed by ' +
    'the context string the signing host applies) goes in the command as confirmation { alg, keyId, publicKey, signature, nonce }. It is valid only ' +
    'for the current PLM state of this document. An agent cannot sign. Read-only.',
  annotations: { readOnly: true },
  params: z.object({
    command: z.enum(GATED_COMMANDS).describe('The human-only command to authorize.'),
    params: z
      .record(z.string(), z.unknown())
      .describe('The params the command will be called with (confirmation, at and by are not part of the payload).'),
    nonce: z.string().min(8).describe('A fresh random string chosen by the signer (at least 8 characters).'),
  }),
  run: (doc, { command, params, nonce }): CommandResult => {
    const payload = actPayload(doc, command, params, nonce);
    return report(doc, `Payload to sign for ${command}: sha256 ${payload}.`, { payloadSha256: payload, ...actParts(doc, command, params) });
  },
});
