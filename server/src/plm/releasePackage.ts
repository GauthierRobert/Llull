/**
 * Signed release package of a frozen revision (09 PLM FR-PLM-21, §6.1): a read-only folder with the canonical definition, sheet SVGs, a manifest
 * of SHA-256 per member and the recorded signatures. Verification needs no llull: `sha256sum` per member plus any RFC 8032 verifier over the
 * canonical release body (`verifyReleasePackage` does exactly that with node:crypto).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { SignatureRecord } from '@core/model/plm';
import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';

interface PackageMember {
  readonly path: string;
  readonly role: 'native-definition' | 'drawing';
  readonly mediaType: string;
  readonly canonical: boolean;
  readonly sha256: string;
  readonly bytes: number;
}

type Manifest = Record<string, unknown>;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The fields of the release body a package manifest repeats; the signed body is rebuilt from them. */
const BODY_KEYS = [
  'schema',
  'item',
  'lifecycleState',
  'change',
  'effectivity',
  'marking',
  'releasedAt',
  'releasedBy',
  'documentContentHash',
  'reviewRequired',
  'unverified',
];

/** The exact release body a signature covers, rebuilt from a package manifest (`tool` keeps only name and releaseScopeFormat). */
export function signedBodyOf(manifest: Manifest): Manifest {
  const tool = isRecord(manifest['tool']) ? manifest['tool'] : {};
  return {
    ...Object.fromEntries(BODY_KEYS.map((key) => [key, manifest[key]])),
    tool: { name: tool['name'], releaseScopeFormat: tool['releaseScopeFormat'] },
  };
}

export interface PackageFiles {
  readonly manifest: Manifest;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly notes: readonly string[];
}

/** The package of released revision `label` of `doc`: files in memory, none written. @failure not a frozen revision -> a reason string */
export function buildReleasePackage(doc: CadDocument, label: string, toolVersion: string): PackageFiles | string {
  const plm = doc.plm;
  const revision = plm?.item.revisions[label];
  if (plm === undefined || revision?.snapshot === undefined || revision.contentHash === undefined)
    return `revision '${label}' is not a frozen (released, superseded or obsolete) revision of a managed item`;
  const manifestQuery = execute(doc, 'release_manifest', { revision: label });
  const body = (manifestQuery.data as { body?: Manifest } | undefined)?.body;
  if (manifestQuery.rejected === true || body === undefined) return manifestQuery.summary;
  const stem = `${plm.item.partNumber}_${label}`;
  const modelPath = `model/${stem}.llull.json`;
  const files: { path: string; content: string }[] = [{ path: modelPath, content: revision.snapshot.canonicalJson }];
  const members: PackageMember[] = [
    {
      path: modelPath,
      role: 'native-definition',
      mediaType: 'application/json',
      canonical: true,
      sha256: sha256(revision.snapshot.canonicalJson),
      bytes: byteLength(revision.snapshot.canonicalJson),
    },
  ];
  const notes: string[] = [];
  const frozen = frozenDocument(doc, label, revision.snapshot.canonicalJson);
  for (const [index, sheetId] of (frozen?.drawings?.order ?? []).entries()) {
    const sheet = frozen === null ? undefined : execute(frozen, 'export_sheet_svg', { sheetId });
    const svg = (sheet?.data as { svg?: string } | undefined)?.svg;
    if (svg === undefined) {
      notes.push(`sheet ${sheetId} not written: ${sheet?.summary ?? 'definition could not be rebuilt'}`);
      continue;
    }
    const file = `drawings/${stem}_sheet${index + 1}.svg`;
    files.push({ path: file, content: svg });
    members.push({
      path: file,
      role: 'drawing',
      mediaType: 'image/svg+xml',
      canonical: false,
      sha256: sha256(svg),
      bytes: byteLength(svg),
    });
  }
  const bodyTool = isRecord(body['tool']) ? body['tool'] : {};
  const unsealed: Manifest = { ...body, tool: { ...bodyTool, version: toolVersion }, members, documentContentHash: revision.contentHash };
  const signatures = revision.signatures.filter((signature) => signature.target.kind === 'release' && signature.target.ref === label);
  const manifest: Manifest = { ...unsealed, manifestSha256: sha256(canonicalJson(unsealed)), signatures };
  return { manifest, files, notes };
}

/** The frozen definition of `label` as a document (snapshot loaded; the PLM record points at that revision so sheets print it), or null. */
function frozenDocument(doc: CadDocument, label: string, snapshot: string): CadDocument | null {
  const envelope = JSON.parse(snapshot) as { document: Record<string, unknown> };
  const json = JSON.stringify({ ...envelope, document: { ...envelope.document, selection: [], camera: doc.camera } });
  const loaded = execute(createEmptyDocument(), 'load_document', { json });
  if (loaded.document === undefined || doc.plm === undefined || loaded.rejected === true) return null;
  return { ...loaded.document, plm: { ...doc.plm, item: { ...doc.plm.item, currentRevision: label } } };
}

/** Write the package into `outDir` (created; files made read-only) and return the manifest hash. @failure an existing manifest.json -> throws, nothing overwritten */
export function writeReleasePackage(pack: PackageFiles, outDir: string): { readonly manifestSha256: string; readonly files: number } {
  if (existsSync(path.join(outDir, 'manifest.json'))) throw new Error(`${outDir} already holds a release package; packages are immutable`);
  const all = [...pack.files, { path: 'manifest.json', content: `${JSON.stringify(pack.manifest, null, 2)}\n` }];
  for (const file of all) {
    const target = path.join(outDir, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
    chmodSync(target, 0o444);
  }
  return { manifestSha256: String(pack.manifest['manifestSha256']), files: all.length };
}

export interface PackageFinding {
  readonly code:
    | 'PLM_PACKAGE_MEMBER_MISMATCH'
    | 'PLM_PACKAGE_MANIFEST_MISMATCH'
    | 'PLM_SIGNATURE_INVALID'
    | 'PLM_KEY_UNTRUSTED'
    | 'PLM_PACKAGE_UNREADABLE'
    | 'PLM_SIGNATURE_UNVERIFIED';
  readonly message: string;
  readonly path?: string;
}

/**
 * Verify a package folder: every member hash and size, the document content hash, the manifest hash and every signature over the rebuilt
 * canonical release body (with the port's trust of the signing key).
 * @invariant read-only; flipping one byte of any member or of the manifest yields a finding
 */
export function verifyReleasePackage(
  dir: string,
  port: HumanSignaturePort | null,
): { readonly ok: boolean; readonly findings: readonly PackageFinding[]; readonly members: number } {
  const findings: PackageFinding[] = [];
  let manifest: Manifest;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!isRecord(parsed)) throw new Error('manifest.json is not an object');
    manifest = parsed;
  } catch (error) {
    return {
      ok: false,
      members: 0,
      findings: [{ code: 'PLM_PACKAGE_UNREADABLE', message: `manifest.json: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  const members = Array.isArray(manifest['members']) ? (manifest['members'] as PackageMember[]) : [];
  for (const member of members) {
    const file = path.join(dir, member.path);
    const content = existsSync(file) ? readFileSync(file) : null;
    if (content === null || sha256(content) !== member.sha256 || content.length !== member.bytes)
      findings.push({
        code: 'PLM_PACKAGE_MEMBER_MISMATCH',
        message: `${member.path} is missing or differs from the manifest`,
        path: member.path,
      });
  }
  const model = members.find((member) => member.canonical);
  if (model === undefined || model.sha256 !== manifest['documentContentHash'])
    findings.push({
      code: 'PLM_PACKAGE_MANIFEST_MISMATCH',
      message: 'documentContentHash is not the hash of the canonical definition member',
    });
  const { manifestSha256, signatures, ...unsealed } = manifest;
  if (sha256(canonicalJson(unsealed)) !== manifestSha256)
    findings.push({ code: 'PLM_PACKAGE_MANIFEST_MISMATCH', message: 'manifestSha256 does not match the manifest content' });
  const signedBody = canonicalJson(signedBodyOf(manifest));
  for (const signature of Array.isArray(signatures) ? (signatures as SignatureRecord[]) : []) {
    if (port?.verifyEd25519 === undefined) {
      findings.push({ code: 'PLM_SIGNATURE_UNVERIFIED', message: `signature by ${signature.signer.userId} not verified: no verifier` });
    } else if (sha256(signedBody) !== signature.signedSha256 || !port.verifyEd25519(signature.publicKey, signedBody, signature.signature)) {
      findings.push({
        code: 'PLM_SIGNATURE_INVALID',
        message: `signature by ${signature.signer.userId} (key ${signature.keyId}) does not verify`,
      });
    } else if (port.keyTrust?.(signature.publicKey) !== 'trusted') {
      findings.push({ code: 'PLM_KEY_UNTRUSTED', message: `key ${signature.keyId} of ${signature.signer.userId} is not trusted here` });
    }
  }
  return { ok: findings.length === 0, findings, members: members.length };
}
