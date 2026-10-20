/** record_signature / attach_release_package: Ed25519 signatures over canonical manifests and the package hash (FR-PLM-20/21, TR-PLM-07/16). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { SignatureRecord } from '@core/model/plm';
import { manifestFor } from '../manifest';
import { refusePlm } from '../refusal';
import { NOT_MANAGED, humanGateRefusal, revisionText } from '../state';
import { withRevision } from '../revisions';
import { atSchema } from '../params';

const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;

/**
 * @affects doc.plm.item.revisions[ref].signatures (appends one verified SignatureRecord)
 * @invariant recorded only when the port verifies the Ed25519 signature over the exact canonical manifest bytes (release_manifest) AND the key is
 *   trusted; the command never signs and never holds a key
 * @failure agent caller (approval / release) -> PLM_HUMAN_GATE; no verifier -> PLM_SIGNATURE_PORT_MISSING; bad signature -> PLM_SIGNATURE_INVALID;
 *   unregistered / revoked / test key -> PLM_KEY_UNTRUSTED; unknown target -> PLM_REVISION_UNKNOWN / PLM_NOT_RELEASED (refusals, unchanged doc)
 */
export const recordSignature = defineCommand({
  name: 'record_signature',
  description:
    'HUMAN GATE. Record an Ed25519 signature made by a human with the host key store (desktop "Approve & sign") over the canonical manifest of a target: ' +
    '{ kind: "iteration", ref: "A.2" } (what an approver signs before release; the bytes are release_manifest with kind "iteration") or ' +
    '{ kind: "release", ref: "A" } (a released revision). The signature is verified with the host verifier and the key must be registered; it never ' +
    'signs. An agent caller gets PLM_HUMAN_GATE for approval / release meanings.',
  annotations: { destructive: true, metaHistory: true },
  params: z.object({
    target: z
      .object({
        kind: z
          .enum(['release', 'iteration'])
          .describe("'iteration' (before release, ref '<revision>.<n>') or 'release' (ref '<revision>')."),
        ref: z.string().describe("Iteration ref like 'A.2', or a revision label like 'A'."),
      })
      .describe('What was signed.'),
    alg: z.literal('Ed25519').describe("Signature algorithm: only 'Ed25519'."),
    keyId: z.string().min(1).describe('Id of the signer key in the vault key registry.'),
    publicKey: z.string().describe('Ed25519 public key, 64 lowercase hex characters.'),
    signature: z.string().describe('Ed25519 signature, 128 lowercase hex characters, over the UTF-8 canonical manifest bytes.'),
    meaning: z.enum(['authorship', 'review', 'approval', 'release']).describe('What the signer attests.'),
    signer: z
      .object({ userId: z.string().min(1).describe('Signer user id.'), name: z.string().min(1).describe('Signer display name.') })
      .describe('Who signed.'),
    at: atSchema.describe('When it was signed (ISO-8601 UTC).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'record_signature', 'PLM_NOT_MANAGED', NOT_MANAGED);
    if (params.meaning === 'approval' || params.meaning === 'release') {
      const gate = humanGateRefusal(doc, 'record_signature', ctx, [params.target.ref]);
      if (gate !== null) return gate;
    }
    const port = ctx?.humanSignature ?? null;
    if (port === null || port.verifyEd25519 === undefined)
      return refusePlm(
        doc,
        'record_signature',
        'PLM_SIGNATURE_PORT_MISSING',
        'signature verification needs the desktop or server host (no verifier installed)',
      );
    const label = params.target.ref.split('.')[0] ?? '';
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'record_signature', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [
        params.target.ref,
      ]);
    if (params.target.kind === 'release' && revision.contentHash === undefined)
      return refusePlm(
        doc,
        'record_signature',
        'PLM_NOT_RELEASED',
        `${revisionText(plm, label)} is ${revision.state}; a release signature needs a released revision`,
        [label],
      );
    const manifest = manifestFor(plm, params.target);
    if (manifest === null)
      return refusePlm(doc, 'record_signature', 'PLM_REVISION_UNKNOWN', `no manifest for ${params.target.kind} '${params.target.ref}'`, [
        params.target.ref,
      ]);
    if (
      !HEX_KEY.test(params.publicKey) ||
      !HEX_SIGNATURE.test(params.signature) ||
      !port.verifyEd25519(params.publicKey, manifest.canonical, params.signature)
    )
      return refusePlm(
        doc,
        'record_signature',
        'PLM_SIGNATURE_INVALID',
        'signature does not verify over the canonical manifest bytes',
        [params.target.ref],
        ['signature'],
      );
    if (port.keyTrust?.(params.publicKey) !== 'trusted')
      return refusePlm(
        doc,
        'record_signature',
        'PLM_KEY_UNTRUSTED',
        `key '${params.keyId}' is not a registered trusted key`,
        [params.keyId],
        ['publicKey'],
      );
    const record: SignatureRecord = {
      alg: 'Ed25519',
      keyId: params.keyId,
      publicKey: params.publicKey,
      meaning: params.meaning,
      signer: params.signer,
      signedAt: params.at,
      target: params.target,
      signedSha256: manifest.sha256,
      signature: params.signature,
    };
    const next = withRevision(doc, plm, label, { ...revision, signatures: [...revision.signatures, record] });
    return changed(
      next,
      `${revisionText(plm, label)}: ${params.meaning} signature by ${params.signer.userId} (key ${params.keyId}) recorded over ${params.target.kind} ${params.target.ref}, sha256 ${manifest.sha256.slice(0, 12)}…`,
      [],
    );
  },
});

/**
 * @affects doc.plm.item.revisions[revision].packageSha256 (and the package location in the summary)
 * @invariant the package manifest's documentContentHash must equal the revision's contentHash
 * @failure agent caller -> PLM_HUMAN_GATE; revision not released -> PLM_NOT_RELEASED; hash mismatch -> PLM_INTEGRITY_MISMATCH (refusals, unchanged doc)
 */
export const attachReleasePackage = defineCommand({
  name: 'attach_release_package',
  description:
    'HUMAN GATE. Record that the host wrote the signed release package of a released revision: its manifest SHA-256 and the documentContentHash it ' +
    'states (must equal the revision content hash). Called by the desktop / `llull release pack` after writing the package; an agent caller gets PLM_HUMAN_GATE.',
  params: z.object({
    revision: z.string().describe('Released revision label.'),
    manifestSha256: z
      .string()
      .regex(HEX_KEY, '64 lowercase hex characters')
      .describe('SHA-256 (64 hex) of the canonical package manifest.'),
    documentContentHash: z.string().describe("The package manifest's documentContentHash; must equal the revision's content hash."),
    location: z.string().optional().describe('Where the package was written (informational).'),
  }),
  run: (doc, { revision: label, manifestSha256, documentContentHash, location }, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'attach_release_package', 'PLM_NOT_MANAGED', NOT_MANAGED);
    const gate = humanGateRefusal(doc, 'attach_release_package', ctx, [label]);
    if (gate !== null) return gate;
    const revision = plm.item.revisions[label];
    if (revision === undefined)
      return refusePlm(doc, 'attach_release_package', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${label}'`, [label]);
    if (revision.contentHash === undefined)
      return refusePlm(
        doc,
        'attach_release_package',
        'PLM_NOT_RELEASED',
        `${revisionText(plm, label)} is ${revision.state}, not released`,
        [label],
      );
    if (documentContentHash !== revision.contentHash)
      return refusePlm(
        doc,
        'attach_release_package',
        'PLM_INTEGRITY_MISMATCH',
        `package content hash ${documentContentHash.slice(0, 12)}… differs from ${revisionText(plm, label)} (${revision.contentHash.slice(0, 12)}…)`,
        [label],
      );
    return changed(
      withRevision(doc, plm, label, { ...revision, packageSha256: manifestSha256 }),
      `${revisionText(plm, label)}: release package ${manifestSha256.slice(0, 12)}…${location !== undefined ? ` at ${location}` : ''} attached.`,
      [],
    );
  },
});
