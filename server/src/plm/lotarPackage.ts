/**
 * LOTAR-style archive package of a frozen revision (09 PLM M6, modelled on EN 9300 long-term archiving; NOT conformant to it): the signed release package (native definition, drawings, manifest of SHA-256 per
 * member, signatures) extended with the AP242 PDM data of the revision, the validation properties of the definition, the PLM records (baselines, as-built, MBOM, imported
 * FAI results) and a verification procedure. Everything the release package guarantees still holds (`llull release verify` works on it); `verifyLotarPackage` adds the
 * archive checks: the validation properties re-derived from the archived definition, the PDM file read back and compared with the manifest, the sealed records.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import type { ObjectStorePort } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { jcsJson } from '@lib/jcs';
import { type ValidationProperties, compareValidation, documentOfSnapshot, validationPropertiesOf } from '@plm/lotar/validation';
import { readPdm } from '@plm/pdm/read';
import { isSealed } from '@plm/records';
import { serverContext } from '../fea/context';
import { type PackageFiles, type PackageFinding, buildReleasePackage, verifyReleasePackage } from './releasePackage';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

const LOTAR_SCHEMA = 'llull-lotar-1';

/** The checks `verifyLotarPackage` makes, in the order they are listed in the package (also written in VERIFY.txt). */
const VERIFICATION_STEPS = [
  'every member re-hashed against manifest.json (sha256sum works)',
  'manifestSha256 recomputed over the canonical manifest and compared with the hash a human attached or received out-of-band',
  'every Ed25519 release signature verified over the canonical release body (any RFC 8032 verifier works)',
  'validation/validation-properties.json equals manifest.lotar.validationProperties',
  'validation properties re-derived from the archived native definition and compared (volume, area, centroid per solid; counts)',
  'pdm/*.stp read back and compared with the manifest (part number, revision, frozen state, content hash)',
  'records/plm-records.json parsed and every sealed record (as-built, MBOM) checked against its seal',
];

interface PackageMemberRecord {
  readonly path: string;
  readonly role: string;
  readonly mediaType: string;
  readonly canonical: boolean;
  readonly sha256: string;
  readonly bytes: number;
}

export interface LotarOptions {
  readonly organization?: { readonly id: string; readonly name: string };
  /** The human confirmation for export-controlled content (the object `confirmExportControlled` takes); never made by this code. */
  readonly confirmExportControlled?: unknown;
}

const verifyText = (stem: string): string =>
  [
    `LOTAR archive package of ${stem} (llull-lotar-1)`,
    '',
    'Verification, with or without llull:',
    ...VERIFICATION_STEPS.map((step, index) => `${index + 1}. ${step}`),
    '',
    'With llull: llull lotar verify <this folder> [--manifest-sha256 HASH | --doc FILE]',
    'The manifest hash must come from the person who released the item (attach_release_package) or from a record you trust: without it the verdict is PLM_PACKAGE_UNANCHORED.',
    '',
  ].join('\n');

/** The records of the managed item that matter for the archive: baselines, sealed as-built records and MBOMs, and the result sets of this revision. */
function recordsOf(doc: CadDocument, label: string): Record<string, unknown> {
  const plm = doc.plm;
  return {
    schema: 'llull-plm-records-1',
    revision: label,
    baselines: Object.values(plm?.baselines ?? {}),
    asBuilt: Object.values(plm?.asBuilt ?? {}),
    mbom: Object.values(plm?.mbom ?? {}),
    faiResults: Object.values(plm?.faiResults ?? {}).filter((set) => set.revision === label),
  };
}

/** The LOTAR package of released / superseded / obsolete revision `label` in memory: files and manifest, none written. @failure a reason string */
export function buildLotarPackage(
  doc: CadDocument,
  label: string,
  toolVersion: string,
  objects: ObjectStorePort | null | undefined,
  options: LotarOptions = {},
): PackageFiles | string {
  const release = buildReleasePackage(doc, label, toolVersion, objects);
  if (typeof release === 'string') return release;
  const plm = doc.plm;
  const revision = plm?.item.revisions[label];
  if (plm === undefined || revision === undefined) return `no revision '${label}'`;
  const context = serverContext();
  const pdm = execute(
    doc,
    'export_step_pdm',
    {
      revision: label,
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.confirmExportControlled === undefined ? {} : { confirmExportControlled: options.confirmExportControlled }),
    },
    context,
  );
  const step = (pdm.data as { step?: string } | undefined)?.step;
  if (pdm.rejected === true || step === undefined) return pdm.summary;
  const properties = execute(
    doc,
    'lotar_validation_properties',
    { revision: label },
    { ...context, objects: objects ?? context.objects ?? null },
  );
  const validation = (properties.data as { validation?: ValidationProperties } | undefined)?.validation;
  if (properties.rejected === true || validation === undefined) return properties.summary;

  const stem = `${plm.item.partNumber.replace(/[^A-Za-z0-9._-]/g, '_')}_${label}`;
  const added: { path: string; role: string; mediaType: string; content: string }[] = [
    { path: `pdm/${stem}.pdm.stp`, role: 'neutral-pdm', mediaType: 'application/step', content: step },
    {
      path: 'validation/validation-properties.json',
      role: 'validation-properties',
      mediaType: 'application/json',
      content: `${jcsJson(validation)}\n`,
    },
    {
      path: 'records/plm-records.json',
      role: 'plm-records',
      mediaType: 'application/json',
      content: `${jcsJson(recordsOf(doc, label))}\n`,
    },
    { path: 'VERIFY.txt', role: 'documentation', mediaType: 'text/plain', content: verifyText(stem) },
  ];
  const unsealed = Object.fromEntries(Object.entries(release.manifest).filter(([key]) => key !== 'manifestSha256' && key !== 'signatures'));
  const members: PackageMemberRecord[] = [
    ...(Array.isArray(unsealed['members']) ? (unsealed['members'] as PackageMemberRecord[]) : []),
    ...added.map((file) => ({
      path: file.path,
      role: file.role,
      mediaType: file.mediaType,
      canonical: false,
      sha256: sha256(file.content),
      bytes: byteLength(file.content),
    })),
  ];
  const lotar = {
    schema: LOTAR_SCHEMA,
    standard:
      'modelled on EN 9300 (LOTAR) and OAIS (ISO 14721): content, validation properties, manifest and verification; not conformant to EN 9300',
    content: {
      native: members.find((member) => member.canonical)?.path ?? null,
      neutral: added[0]?.path ?? null,
      records: 'records/plm-records.json',
    },
    validationProperties: validation,
    verification: VERIFICATION_STEPS,
  };
  const next = { ...unsealed, members, lotar };
  const manifest = { ...next, manifestSha256: sha256(jcsJson(next)), signatures: release.manifest['signatures'] };
  return {
    manifest,
    files: [...release.files, ...added.map(({ path: file, content }) => ({ path: file, content }))],
    notes: release.notes,
  };
}

export interface LotarFinding {
  readonly code:
    | PackageFinding['code']
    | 'PLM_LOTAR_NOT_A_PACKAGE'
    | 'PLM_LOTAR_VALIDATION_MISMATCH'
    | 'PLM_LOTAR_PDM_MISMATCH'
    | 'PLM_LOTAR_RECORDS_MISMATCH';
  readonly message: string;
  readonly path?: string;
}

const parseJson = (text: string | null): unknown => {
  try {
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
};

const read = (root: string, relative: string): string | null => {
  try {
    const target = path.resolve(root, relative);
    return target.startsWith(path.resolve(root) + path.sep) ? readFileSync(target, 'utf8') : null;
  } catch {
    return null;
  }
};

/**
 * Verify a LOTAR package folder: everything `verifyReleasePackage` verifies, then the archive checks (validation properties re-derived from the archived definition, PDM read-back, sealed records).
 * @invariant read-only; a package whose manifest has no `lotar` section is not a LOTAR package (PLM_LOTAR_NOT_A_PACKAGE)
 */
export function verifyLotarPackage(
  dir: string,
  port: HumanSignaturePort | null,
  anchor: string | null = null,
): { readonly ok: boolean; readonly findings: readonly LotarFinding[]; readonly members: number; readonly rederived: boolean } {
  const base = verifyReleasePackage(dir, port, anchor);
  const findings: LotarFinding[] = [...base.findings];
  const manifest = parseJson(read(dir, 'manifest.json'));
  if (!isRecord(manifest)) return { ok: false, findings, members: base.members, rederived: false };
  // A member whose hash already failed is not parsed: its content is not what the manifest vouches for.
  const damaged = new Set(
    base.findings.flatMap((finding) =>
      finding.code === 'PLM_PACKAGE_MEMBER_MISMATCH' && finding.path !== undefined ? [finding.path] : [],
    ),
  );
  const intact = (file: string | null): file is string => file !== null && !damaged.has(file);
  const lotar = isRecord(manifest) && isRecord(manifest['lotar']) ? manifest['lotar'] : null;
  if (!isRecord(manifest) || lotar === null || lotar['schema'] !== LOTAR_SCHEMA) {
    findings.push({
      code: 'PLM_LOTAR_NOT_A_PACKAGE',
      message: `manifest.json has no ${LOTAR_SCHEMA} section: this is not a LOTAR archive package`,
    });
    return { ok: false, findings, members: base.members, rederived: false };
  }
  if (!isRecord(lotar['validationProperties'])) {
    findings.push({ code: 'PLM_LOTAR_VALIDATION_MISMATCH', message: 'manifest.lotar.validationProperties is missing' });
    return { ok: false, findings, members: base.members, rederived: false };
  }
  const archived = lotar['validationProperties'] as unknown as ValidationProperties;
  const content = isRecord(lotar['content']) ? lotar['content'] : {};
  const fail = (code: LotarFinding['code'], message: string, file?: string): void => {
    findings.push({ code, message, ...(file === undefined ? {} : { path: file }) });
  };
  const stored = intact('validation/validation-properties.json') ? read(dir, 'validation/validation-properties.json') : undefined;
  if (stored !== undefined && (stored === null || stored.trim() !== jcsJson(archived)))
    fail(
      'PLM_LOTAR_VALIDATION_MISMATCH',
      'validation/validation-properties.json differs from manifest.lotar.validationProperties',
      'validation/validation-properties.json',
    );
  let rederived = false;
  const nativePath = typeof content['native'] === 'string' ? content['native'] : null;
  const snapshot = intact(nativePath) ? read(dir, nativePath) : undefined;
  const frozen = snapshot === undefined || snapshot === null ? null : documentOfSnapshot(snapshot);
  if (snapshot === undefined) rederived = false;
  else if (frozen === null)
    fail(
      'PLM_LOTAR_VALIDATION_MISMATCH',
      'the archived native definition cannot be loaded to re-derive the validation properties',
      nativePath ?? undefined,
    );
  else {
    rederived = true;
    for (const message of compareValidation(archived, validationPropertiesOf(frozen)))
      fail('PLM_LOTAR_VALIDATION_MISMATCH', message, nativePath ?? undefined);
  }
  const neutralPath = typeof content['neutral'] === 'string' ? content['neutral'] : null;
  const step = intact(neutralPath) ? read(dir, neutralPath) : undefined;
  const model = step === undefined ? undefined : step === null ? 'the PDM file is missing' : readPdm(step);
  const item = isRecord(manifest['item']) ? manifest['item'] : {};
  if (typeof model === 'string') fail('PLM_LOTAR_PDM_MISMATCH', `the PDM file does not read back: ${model}`, neutralPath ?? undefined);
  else if (
    model !== undefined &&
    (model.partNumber !== item['partNumber'] ||
      model.revision !== item['revision'] ||
      model.integrity.contentHash !== manifest['documentContentHash'] ||
      !['released', 'superseded', 'obsolete'].includes(model.state))
  )
    fail(
      'PLM_LOTAR_PDM_MISMATCH',
      'the PDM file does not describe the revision the manifest names (part number, revision, frozen state, content hash)',
      neutralPath ?? undefined,
    );
  const recordsPath = typeof content['records'] === 'string' ? content['records'] : 'records/plm-records.json';
  const records = intact(recordsPath) ? parseJson(read(dir, recordsPath)) : undefined;
  if (records !== undefined && !isRecord(records))
    fail('PLM_LOTAR_RECORDS_MISMATCH', 'records/plm-records.json is missing or not JSON', 'records/plm-records.json');
  else if (isRecord(records))
    for (const key of ['asBuilt', 'mbom', 'faiResults'] as const)
      for (const record of Array.isArray(records[key]) ? records[key] : [])
        if (!isSealed(record)) fail('PLM_LOTAR_RECORDS_MISMATCH', `a ${key} record does not hash to its seal`, 'records/plm-records.json');
  return { ok: findings.length === 0, findings, members: base.members, rederived };
}
