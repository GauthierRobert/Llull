/** plm_diff / verify_release / restore_revision_snapshot: compare, verify and restore frozen definitions (FR-PLM-13/15/16). */

import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { PlmModel, Revision } from '@core/model/plm';
import { sha256Hex } from '@lib/sha256';
import { diffDocuments } from '../diff';
import { integrityOf } from '../integrity';
import { manifestFor } from '../manifest';
import { titleBlockMismatches } from '../readiness';
import { refusePlm } from '../refusal';
import { NOT_MANAGED, revisionText, scopeOf } from '../state';
import { getCommand } from '@core/commands/registry';

const WORKING = 'WORKING';

/** The definition of `label` as parsed JSON: its snapshot, or the live definition for the current revision / 'WORKING'. */
function definitionOf(
  doc: CadDocument,
  plm: PlmModel,
  label: string,
  ctx: ExecutionContext | undefined,
): { json: unknown; source: string } | string {
  const revision = plm.item.revisions[label];
  if (label !== WORKING && revision === undefined) return `${plm.item.partNumber} has no revision '${label}'`;
  if (revision?.snapshot !== undefined)
    return { json: JSON.parse(revision.snapshot.canonicalJson) as unknown, source: `release snapshot ${label}` };
  if (label === WORKING || label === plm.item.currentRevision)
    return { json: JSON.parse(scopeOf(doc, ctx).canonicalJson) as unknown, source: 'working document' };
  return `${revisionText(plm, label)} (${revision?.state ?? '?'}) has no release snapshot`;
}

/**
 * @affects nothing (read-only)
 * @invariant compares frozen definitions only: snapshots, or the live definition for the current revision / "WORKING"
 */
export const plmDiff = defineCommand({
  name: 'plm_diff',
  description:
    'What changed between two revisions of the managed item (or against "WORKING", the live document): parameters (expression from -> to), feature steps ' +
    '(added / removed / edited / suppressed counts and ids), entities, materials, sheet title blocks and effectivity. Revisions without a snapshot ' +
    '(in_work, never released) can only be compared as the current revision. Read-only; volume / mass deltas are not computed yet.',
  annotations: { readOnly: true },
  params: z.object({
    from: z.string().describe('Revision label, or "WORKING".'),
    to: z.string().describe('Revision label, or "WORKING".'),
  }),
  run: (doc, { from, to }, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'plm_diff', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const [a, b] = [definitionOf(doc, plm, from, ctx), definitionOf(doc, plm, to, ctx)];
    for (const side of [a, b]) if (typeof side === 'string') return refusePlm(doc, 'plm_diff', 'PLM_NO_SNAPSHOT', side, [from, to]);
    const diff = diffDocuments((a as { json: unknown }).json, (b as { json: unknown }).json);
    const effectivity = { from: plm.item.revisions[from]?.effectivity ?? null, to: plm.item.revisions[to]?.effectivity ?? null };
    const steps = diff['featureHistory'] as { added: number; removed: number; edited: number; suppressed: number };
    const parameters = diff['parameters'] as { changed: unknown[] };
    return report(
      doc,
      `${plm.item.partNumber} ${from} -> ${to}: ${parameters.changed.length} parameter(s) changed; feature steps +${steps.added} -${steps.removed} ~${steps.edited} (${steps.suppressed} suppression change(s)).`,
      { ...diff, effectivity },
    );
  },
});

function signatureStatus(plm: PlmModel, revision: Revision, ctx: ExecutionContext | undefined): boolean | string {
  if (revision.signatures.length === 0) return 'n/a (none attached)';
  const port = ctx?.humanSignature ?? null;
  if (port?.verifyEd25519 === undefined) return 'unverified (no verifier port)';
  return revision.signatures.every((signature) => {
    const manifest = manifestFor(plm, signature.target, signature.meaning);
    return (
      manifest !== null &&
      manifest.sha256 === signature.signedSha256 &&
      port.verifyEd25519?.(signature.publicKey, manifest.canonical, signature.signature) === true
    );
  });
}

/**
 * @affects nothing (read-only)
 * @invariant recomputes every hash and signature on demand; released, superseded and obsolete revisions all verify
 */
export const verifyRelease = defineCommand({
  name: 'verify_release',
  description:
    'Verify a frozen revision (released, superseded or obsolete): the snapshot still hashes to the recorded content hash, the live definition still ' +
    'matches it while the revision is the current released one, every recorded signature still verifies (needs the host verifier), and sheet title ' +
    'blocks agree with the managed identity. Returns data { contentHashMatches, liveDefinitionMatches, signaturesValid, titleBlockConsistent, ' +
    'reconstructedFrom }. Read-only. Regenerating geometry to compare fingerprints is not implemented yet.',
  annotations: { readOnly: true },
  params: z.object({ revision: z.string().describe('Revision label, e.g. "A".') }),
  run: (doc, { revision: label }, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'verify_release', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'verify_release', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    if (revision.contentHash === undefined || revision.snapshot === undefined)
      return refusePlm(
        doc,
        'verify_release',
        'PLM_NOT_RELEASED',
        `${revisionText(plm, label)} is ${revision.state}; only a released, superseded or obsolete revision verifies`,
        [label],
      );
    const contentHashMatches = sha256Hex(revision.snapshot.canonicalJson) === revision.contentHash;
    const live =
      label === plm.item.currentRevision && revision.state === 'released'
        ? scopeOf(doc, ctx).sha256 === revision.contentHash
        : 'n/a (not the current released revision)';
    const signaturesValid = signatureStatus(plm, revision, ctx);
    const titleBlockConsistent = label === plm.item.currentRevision ? titleBlockMismatches(doc, plm).length === 0 : 'n/a';
    const ok = contentHashMatches && live !== false && signaturesValid !== false;
    return report(
      doc,
      `${revisionText(plm, label)} ${ok ? 'verified' : 'FAILED verification'}: content hash ${contentHashMatches ? 'matches' : 'MISMATCH'}, live definition ${String(live)}, signatures ${String(signaturesValid)}.`,
      {
        contentHashMatches,
        liveDefinitionMatches: live,
        signaturesValid,
        titleBlockConsistent,
        reconstructedFrom: `release snapshot ${label}`,
        integrity: integrityOf(doc, plm, ctx)[label] ?? null,
      },
    );
  },
});

/**
 * @affects the whole definition (replaced by the frozen snapshot; view state and the PLM record are kept)
 * @invariant allowed only while the recomputed integrity of that revision is a mismatch; the released history never changes
 * @failure unknown revision / no snapshot -> PLM_REVISION_UNKNOWN / PLM_NO_SNAPSHOT; integrity ok -> PLM_PARAM_INVALID (nothing to restore)
 */
export const restoreRevisionSnapshot = defineCommand({
  name: 'restore_revision_snapshot',
  description:
    'Repair a document whose released definition no longer matches its recorded content hash (tampered file, integrity mismatch reported by load_document ' +
    'or plm_status): replace the definition with the revision snapshot. Refused while the integrity is ok. Camera, selection and the PLM record are kept.',
  annotations: { destructive: true, metaHistory: true },
  params: z.object({ revision: z.string().describe('The current released revision to restore, e.g. "A".') }),
  run: (doc, { revision: label }, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'restore_revision_snapshot', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'restore_revision_snapshot', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [
        label,
      ]);
    if (revision.snapshot === undefined)
      return refusePlm(doc, 'restore_revision_snapshot', 'PLM_NO_SNAPSHOT', `${revisionText(plm, label)} has no release snapshot`, [label]);
    if (label !== plm.item.currentRevision || integrityOf(doc, plm, ctx)[label] !== 'mismatch')
      return refusePlm(
        doc,
        'restore_revision_snapshot',
        'PLM_PARAM_INVALID',
        `${revisionText(plm, label)} integrity is not a mismatch on the current revision; nothing to restore`,
        [label],
      );
    const load = (ctx?.registry ?? getCommand)('load_document');
    const envelope = JSON.parse(revision.snapshot.canonicalJson) as { document: Record<string, unknown> };
    const withViewState = { ...envelope, document: { ...envelope.document, selection: [], camera: doc.camera } };
    const loaded = load?.run(doc, { json: JSON.stringify(withViewState) }, ctx);
    if (loaded === undefined || loaded.document === doc)
      return refusePlm(
        doc,
        'restore_revision_snapshot',
        'PLM_INTEGRITY_MISMATCH',
        `the snapshot of ${label} could not be loaded: ${loaded?.summary ?? 'load_document missing'}`,
        [label],
      );
    const restored: CadDocument = { ...loaded.document, camera: doc.camera, selection: doc.selection, plm };
    return changed(
      restored,
      `${revisionText(plm, label)} definition restored from its release snapshot (${revision.snapshot.canonicalJson.length} bytes).`,
      restored.order,
    );
  },
});
