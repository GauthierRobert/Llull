/**
 * Signed release package of a frozen revision (09 PLM FR-PLM-21, §6.1): a read-only folder with the canonical definition, sheet SVGs, a manifest
 * of SHA-256 per member and the recorded signatures. Verification needs no llull: `sha256sum` per member plus any RFC 8032 verifier over the
 * canonical release body (`verifyReleasePackage` does exactly that with node:crypto).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../sha256';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { ObjectStorePort } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { SignatureRecord } from '@core/model/plm';
import { jcsJson } from '@lib/jcs';
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
  'structure',
];

/** The exact release body a signature covers, rebuilt from a package manifest (`tool` keeps only name and releaseScopeFormat). */
export function signedBodyOf(manifest: Manifest, meaning: string): Manifest {
  const tool = isRecord(manifest['tool']) ? manifest['tool'] : {};
  return {
    ...Object.fromEntries(BODY_KEYS.flatMap((key) => (manifest[key] === undefined ? [] : [[key, manifest[key]]]))),
    meaning,
    tool: { name: tool['name'], releaseScopeFormat: tool['releaseScopeFormat'] },
  };
}

/** A file-name stem of a part number: only A-Z a-z 0-9 . _ - (anything else becomes _), no leading dot, no "..". */
function safeStem(text: string): string {
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .split('..')
    .join('_')
    .replace(/^\.+/, '_');
  return cleaned === '' ? '_' : cleaned;
}

/** `relative` resolved under `root`, or null when it is absolute or leaves `root` (path traversal). */
function insideOf(root: string, relative: string): string | null {
  if (path.isAbsolute(relative) || relative.includes('\0')) return null;
  const target = path.resolve(root, relative);
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

export interface PackageFiles {
  readonly manifest: Manifest;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly notes: readonly string[];
}

/** The package of released revision `label` of `doc`: files in memory, none written. @failure not a frozen revision -> a reason string */
export function buildReleasePackage(
  doc: CadDocument,
  label: string,
  toolVersion: string,
  objects?: ObjectStorePort | null,
): PackageFiles | string {
  const plm = doc.plm;
  const revision = plm?.item.revisions[label];
  if (plm === undefined || revision?.snapshot === undefined || revision.contentHash === undefined)
    return `revision '${label}' is not a frozen (released, superseded or obsolete) revision of a managed item`;
  const snapshotJson =
    revision.snapshot.kind === 'inline' ? revision.snapshot.canonicalJson : (objects?.get(revision.snapshot.objectSha256) ?? null);
  if (snapshotJson === null)
    return `the snapshot of revision '${label}' is in the vault and no vault object is reachable (set LLULL_VAULT)`;
  const manifestQuery = execute(doc, 'release_manifest', { revision: label });
  const body = (manifestQuery.data as { body?: Manifest } | undefined)?.body;
  if (manifestQuery.rejected === true || body === undefined) return manifestQuery.summary;
  const stem = `${safeStem(plm.item.partNumber)}_${label}`;
  const modelPath = `model/${stem}.llull.json`;
  const files: { path: string; content: string }[] = [{ path: modelPath, content: snapshotJson }];
  const members: PackageMember[] = [
    {
      path: modelPath,
      role: 'native-definition',
      mediaType: 'application/json',
      canonical: true,
      sha256: sha256Hex(snapshotJson),
      bytes: byteLength(snapshotJson),
    },
  ];
  const notes: string[] = [];
  const frozen = frozenDocument(doc, label, snapshotJson);
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
      sha256: sha256Hex(svg),
      bytes: byteLength(svg),
    });
  }
  const bodyTool = isRecord(body['tool']) ? body['tool'] : {};
  const unsealed: Manifest = { ...body, tool: { ...bodyTool, version: toolVersion }, members, documentContentHash: revision.contentHash };
  const signatures = revision.signatures.filter((signature) => signature.target.kind === 'release' && signature.target.ref === label);
  const manifest: Manifest = { ...unsealed, manifestSha256: sha256Hex(jcsJson(unsealed)), signatures };
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
  const root = path.resolve(outDir);
  for (const file of all) {
    const target = insideOf(root, file.path);
    if (target === null) throw new Error(`refusing to write ${file.path}: it leaves the package folder`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
    chmodSync(target, 0o444);
  }
  return { manifestSha256: String(pack.manifest['manifestSha256']), files: all.length };
}

export interface PackageFinding {
  readonly code:
    | 'PLM_PACKAGE_MEMBER_MISMATCH'
    | 'PLM_SIGNATURE_MISSING'
    | 'PLM_PACKAGE_MANIFEST_MISMATCH'
    | 'PLM_PACKAGE_UNANCHORED'
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
 * `anchor` is the manifest hash a human attached (`revision.packageSha256`, set by the human-gated attach_release_package) or received out-of-band: the
 * release signature covers the definition hash, not every member, so without the anchor an attacker who swaps a drawing and recomputes every hash
 * would still pass. No anchor => PLM_PACKAGE_UNANCHORED (not ok).
 * @invariant read-only; flipping one byte of any member or of the manifest yields a finding
 */
export function verifyReleasePackage(
  dir: string,
  port: HumanSignaturePort | null,
  anchor: string | null = null,
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
  const root = path.resolve(dir);
  for (const member of members) {
    const file = insideOf(root, String(member.path));
    const content = file !== null && existsSync(file) ? readFileSync(file) : null;
    if (content === null || sha256Hex(content) !== member.sha256 || content.length !== member.bytes)
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
  if (sha256Hex(jcsJson(unsealed)) !== manifestSha256)
    findings.push({ code: 'PLM_PACKAGE_MANIFEST_MISMATCH', message: 'manifestSha256 does not match the manifest content' });
  if (anchor === null)
    findings.push({
      code: 'PLM_PACKAGE_UNANCHORED',
      message:
        'the manifest hash was not compared to a value a human attached (pass --doc of the managed document, or --manifest-sha256 HASH)',
    });
  else if (anchor !== manifestSha256)
    findings.push({
      code: 'PLM_PACKAGE_MANIFEST_MISMATCH',
      message: 'manifestSha256 differs from the hash a human attached to this revision',
    });
  const recorded = Array.isArray(signatures) ? (signatures as SignatureRecord[]) : [];
  if (recorded.length === 0)
    findings.push({
      code: 'PLM_SIGNATURE_MISSING',
      message: 'the package carries no release signature: nothing proves a human released it',
    });
  for (const signature of recorded) {
    const signedBody = jcsJson(signedBodyOf(manifest, signature.meaning));
    if (port?.verifyEd25519 === undefined) {
      findings.push({ code: 'PLM_SIGNATURE_UNVERIFIED', message: `signature by ${signature.signer.userId} not verified: no verifier` });
    } else if (
      sha256Hex(signedBody) !== signature.signedSha256 ||
      !port.verifyEd25519(signature.publicKey, signedBody, signature.signature)
    ) {
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
