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
  }),
  run: (doc, { revision: label, kind = 'release' }): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'release_manifest', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'release_manifest', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    if (kind === 'release' && revision.contentHash === undefined)
      return refusePlm(doc, 'release_manifest', 'PLM_NOT_RELEASED', `${revisionText(plm, label)} is ${revision.state}, not released`, [
        label,
      ]);
    const manifest = kind === 'release' ? releaseManifest(plm, revision) : iterationManifest(plm, revision, revision.iterations.length);
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
