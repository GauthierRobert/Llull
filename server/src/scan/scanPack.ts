/**
 * Pack and go for point clouds (plant 10 TECHNICAL_SPEC §3, §13.9): `llull pack OUT.zip --with-scans` zips a `.llull` document with the cloud assets
 * its `scan` slice references, `llull unpack` installs them on another machine. The document never embeds points (TR-SCN-04); the archive is the
 * transport. Layout: `pack.json` (versioned manifest with the size and sha256 of every file), `document.llull` (the file as saved, byte for byte),
 * `scans/<assetKey>/{manifest.json,hierarchy.bin,nodes.bin[,source.sha256]}`. Entries are STORED with fixed timestamps, so the same document and
 * assets give the same archive bytes. Unpacking is hostile-input safe: the zip is read with a byte cap, only the fixed entry names of a 64-hex asset
 * key are accepted, every file is checked against its sha256 and the asset's own manifest, and an asset lands in the store atomically.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';
import { zipStore, type ZipEntry } from '@lib/zip';
import { unzip } from '@lib/zipRead';
import { renameWithRetry } from '../writeFileAtomic';
import { sha256Hex } from '../sha256';
import { AssetReader, crc32 } from './assetReader';
import { assetDir, hasAsset, isAssetKey } from './scanStore';

/** Layout version of `pack.json`. */
export const PACK_VERSION = 1;
/** Files of an asset, in archive order (`source.sha256` is optional). */
const ASSET_FILES = ['manifest.json', 'hierarchy.bin', 'nodes.bin', 'source.sha256'] as const;
const REQUIRED_FILES = 3;
/** Default cap on the bytes of one archive (the zip is built and read in memory, without ZIP64). */
export const DEFAULT_PACK_MAX_BYTES = 1 << 30;
const DOCUMENT_ENTRY = 'document.llull';
const MANIFEST_ENTRY = 'pack.json';

export type PackFailureCode =
  | 'SCN_PACK_DOCUMENT_UNREADABLE'
  | 'SCN_PACK_ASSET_MISSING'
  | 'SCN_PACK_ASSET_CORRUPT'
  | 'SCN_PACK_TOO_LARGE'
  | 'SCN_PACK_INVALID'
  | 'SCN_PACK_CHECKSUM'
  | 'SCN_PACK_EXISTS';

export type PackFailure = { readonly ok: false; readonly code: PackFailureCode; readonly message: string };

interface PackedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface PackedScan {
  readonly assetKey: string;
  readonly sourceName: string;
  readonly pointCount: number;
  readonly files: readonly PackedFile[];
}

export interface PackOptions {
  /** The `.llull` document file. */
  readonly document: string;
  readonly out: string;
  /** Include the referenced assets (default false: the archive then lists them and carries the document only). */
  readonly withScans: boolean;
  readonly store: string;
  readonly maxBytes?: number;
}

export type PackResult =
  | {
      readonly ok: true;
      readonly out: string;
      readonly bytes: number;
      readonly assetKeys: readonly string[];
      readonly included: readonly string[];
      readonly documentSha256: string;
    }
  | PackFailure;

const fail = (code: PackFailureCode, message: string): PackFailure => ({ ok: false, code, message });

/** Asset keys the document's `scan` slice references (sorted, unique); null when the file is not a readable document. */
function referencedKeys(documentText: string): string[] | null {
  try {
    const clouds = deserializeDocument(documentText).scan?.clouds ?? {};
    return [...new Set(Object.values(clouds).map((cloud) => cloud.assetKey))].sort();
  } catch {
    return null;
  }
}

/** The first node block of `nodes.bin` whose CRC-32 or extent disagrees with the hierarchy, or undefined (no decoding: bytes only). */
function damagedBlock(reader: AssetReader, nodes: Uint8Array): string | undefined {
  for (const [index, node] of reader.nodes.entries()) {
    const block = nodes.subarray(node.byteOffset, node.byteOffset + node.byteSize);
    if (block.length !== node.byteSize || crc32(block) !== node.crc) return `node block ${index} fails its CRC-32`;
  }
  return undefined;
}

/**
 * @failure unreadable document -> SCN_PACK_DOCUMENT_UNREADABLE; with scans: an asset not in the store or unreadable -> SCN_PACK_ASSET_MISSING
 *   (every missing key named); a node block that fails its CRC-32 -> SCN_PACK_ASSET_CORRUPT; over `maxBytes` -> SCN_PACK_TOO_LARGE. Nothing is written on failure.
 */
export function packDocument(options: PackOptions): PackResult {
  const maxBytes = options.maxBytes ?? DEFAULT_PACK_MAX_BYTES;
  let documentBytes: Buffer;
  try {
    documentBytes = readFileSync(options.document);
  } catch {
    return fail('SCN_PACK_DOCUMENT_UNREADABLE', `cannot read ${options.document}`);
  }
  const keys = referencedKeys(documentBytes.toString('utf8'));
  if (keys === null) return fail('SCN_PACK_DOCUMENT_UNREADABLE', `${options.document} is not a llull document`);
  const entries: ZipEntry[] = [{ name: DOCUMENT_ENTRY, data: documentBytes }];
  const scans: PackedScan[] = [];
  const missing: string[] = [];
  let total = documentBytes.length;
  if (options.withScans) {
    for (const key of keys) {
      const dir = assetDir(options.store, key);
      if (!isAssetKey(key) || !hasAsset(options.store, key) || AssetReader.open(dir, key) === null) {
        missing.push(key);
        continue;
      }
      const files: PackedFile[] = [];
      const reader = AssetReader.open(dir, key);
      const damaged = reader === null ? undefined : damagedBlock(reader, readFileSync(path.join(dir, 'nodes.bin')));
      if (damaged !== undefined)
        return fail('SCN_PACK_ASSET_CORRUPT', `asset ${key}: ${damaged}; re-import the source with llull scan import`);
      for (const name of ASSET_FILES) {
        const file = path.join(dir, name);
        if (!existsSync(file)) continue;
        const data = readFileSync(file);
        total += data.length;
        if (total > maxBytes)
          return fail('SCN_PACK_TOO_LARGE', `the archive would exceed ${maxBytes} bytes; pack without --with-scans or raise --max-bytes`);
        entries.push({ name: `scans/${key}/${name}`, data });
        files.push({ path: `scans/${key}/${name}`, bytes: data.length, sha256: sha256Hex(data) });
      }
      const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      scans.push({
        assetKey: key,
        sourceName: isRecord(manifest) && typeof manifest['sourceName'] === 'string' ? manifest['sourceName'] : '',
        pointCount: isRecord(manifest) && typeof manifest['pointCount'] === 'number' ? manifest['pointCount'] : 0,
        files,
      });
    }
    if (missing.length > 0)
      return fail(
        'SCN_PACK_ASSET_MISSING',
        `${missing.length} referenced asset(s) are not in this machine's store: ${missing.join(', ')}. Run \`llull scan import <file>\` for each, or pack without --with-scans`,
      );
  }
  const documentSha256 = sha256Hex(documentBytes);
  const manifest = canonicalJson({
    version: PACK_VERSION,
    document: { name: DOCUMENT_ENTRY, sha256: documentSha256 },
    assetKeys: keys,
    scans,
  });
  entries.unshift({ name: MANIFEST_ENTRY, data: Buffer.from(manifest) });
  const archive = zipStore(entries);
  mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  const temporary = `${options.out}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, archive);
    renameWithRetry(temporary, options.out);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ok: true, out: options.out, bytes: archive.length, assetKeys: keys, included: scans.map((s) => s.assetKey), documentSha256 };
}

export interface UnpackOptions {
  readonly archive: string;
  /** Where `document.llull` is written. */
  readonly documentOut: string;
  readonly store: string;
  readonly maxBytes?: number;
  /** Replace an existing `documentOut` (default false). */
  readonly overwrite?: boolean;
}

export type UnpackResult =
  | {
      readonly ok: true;
      readonly documentOut: string;
      readonly installed: readonly string[];
      readonly alreadyPresent: readonly string[];
      readonly notIncluded: readonly string[];
    }
  | PackFailure;

const ASSET_PATH = /^scans\/([0-9a-f]{64})\/(manifest\.json|hierarchy\.bin|nodes\.bin|source\.sha256)$/;

/** The validated `pack.json`: the document hash and the packed scans, or the reason it is invalid. */
function readManifest(data: Uint8Array): { documentSha256: string; assetKeys: string[]; scans: PackedScan[] } | string {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return 'pack.json is not JSON';
  }
  if (!isRecord(value) || value['version'] !== PACK_VERSION) return `pack.json is not version ${PACK_VERSION}`;
  const document = value['document'];
  const keys = value['assetKeys'];
  const scans = value['scans'];
  if (!isRecord(document) || typeof document['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(document['sha256']))
    return 'pack.json has no document hash';
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && isAssetKey(k))) return 'pack.json assetKeys are not asset keys';
  if (!Array.isArray(scans)) return 'pack.json has no scans list';
  const packed: PackedScan[] = [];
  for (const scan of scans) {
    if (!isRecord(scan) || typeof scan['assetKey'] !== 'string' || !isAssetKey(scan['assetKey']) || !Array.isArray(scan['files']))
      return 'pack.json holds a malformed scan entry';
    const files: PackedFile[] = [];
    for (const file of scan['files']) {
      if (!isRecord(file) || typeof file['path'] !== 'string' || typeof file['sha256'] !== 'string' || typeof file['bytes'] !== 'number')
        return 'pack.json holds a malformed file entry';
      if (ASSET_PATH.exec(file['path'])?.[1] !== scan['assetKey'])
        return `pack.json lists the unexpected path ${file['path'].slice(0, 80)}`;
      files.push({ path: file['path'], bytes: file['bytes'], sha256: file['sha256'] });
    }
    packed.push({
      assetKey: scan['assetKey'],
      sourceName: String(scan['sourceName'] ?? ''),
      pointCount: Number(scan['pointCount'] ?? 0),
      files,
    });
  }
  return { documentSha256: document['sha256'], assetKeys: keys, scans: packed };
}

/**
 * @failure not a zip / over the byte cap / bad pack.json / an unexpected entry / missing files -> SCN_PACK_INVALID; a size or sha256 that differs
 *   from the manifest, or an asset whose own manifest is not its key -> SCN_PACK_CHECKSUM; `documentOut` exists -> SCN_PACK_EXISTS. Nothing is
 *   installed on failure (every file is verified before the first rename).
 */
export function unpackDocument(options: UnpackOptions): UnpackResult {
  const maxBytes = options.maxBytes ?? DEFAULT_PACK_MAX_BYTES;
  let entries: ZipEntry[];
  try {
    entries = unzip(readFileSync(options.archive), { maxBytes, maxRatio: 1 });
  } catch (error) {
    return fail('SCN_PACK_INVALID', `${options.archive}: ${error instanceof Error ? error.message : 'unreadable archive'}`);
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  const unexpected = entries.find(
    (entry) => entry.name !== DOCUMENT_ENTRY && entry.name !== MANIFEST_ENTRY && !ASSET_PATH.test(entry.name),
  );
  if (unexpected !== undefined) return fail('SCN_PACK_INVALID', `the archive holds the unexpected entry ${unexpected.name.slice(0, 80)}`);
  const manifestBytes = byName.get(MANIFEST_ENTRY);
  const documentBytes = byName.get(DOCUMENT_ENTRY);
  if (manifestBytes === undefined || documentBytes === undefined)
    return fail('SCN_PACK_INVALID', 'the archive has no pack.json / document.llull');
  const manifest = readManifest(manifestBytes);
  if (typeof manifest === 'string') return fail('SCN_PACK_INVALID', manifest);
  if (sha256Hex(documentBytes) !== manifest.documentSha256) return fail('SCN_PACK_CHECKSUM', 'document.llull does not match its sha256');
  if (existsSync(options.documentOut) && options.overwrite !== true)
    return fail('SCN_PACK_EXISTS', `${options.documentOut} exists; pass --force to replace it`);
  const toInstall: PackedScan[] = [];
  const alreadyPresent: string[] = [];
  for (const scan of manifest.scans) {
    for (const file of scan.files) {
      const data = byName.get(file.path);
      if (data === undefined) return fail('SCN_PACK_INVALID', `the archive lacks ${file.path}`);
      if (data.length !== file.bytes || sha256Hex(data) !== file.sha256)
        return fail('SCN_PACK_CHECKSUM', `${file.path} does not match its sha256`);
    }
    if (scan.files.filter((file) => file.path.endsWith('.json') || file.path.endsWith('.bin')).length < REQUIRED_FILES)
      return fail('SCN_PACK_INVALID', `asset ${scan.assetKey} lacks manifest.json, hierarchy.bin or nodes.bin`);
    if (hasAsset(options.store, scan.assetKey)) alreadyPresent.push(scan.assetKey);
    else toInstall.push(scan);
  }
  const staged: { scan: PackedScan; dir: string }[] = [];
  mkdirSync(options.store, { recursive: true });
  try {
    for (const scan of toInstall) {
      const dir = mkdtempSync(path.join(options.store, '.tmp-'));
      staged.push({ scan, dir });
      for (const file of scan.files) writeFileSync(path.join(dir, path.basename(file.path)), byName.get(file.path) ?? Buffer.alloc(0));
      if (AssetReader.open(dir, scan.assetKey) === null)
        return fail(
          'SCN_PACK_CHECKSUM',
          `asset ${scan.assetKey} does not read back as that key (its manifest, node CRCs or layout are wrong)`,
        );
    }
    for (const { scan, dir } of staged) {
      if (hasAsset(options.store, scan.assetKey)) rmSync(dir, { recursive: true, force: true });
      else renameSync(dir, assetDir(options.store, scan.assetKey));
    }
    mkdirSync(path.dirname(path.resolve(options.documentOut)), { recursive: true });
    writeFileSync(options.documentOut, documentBytes);
  } finally {
    for (const { dir } of staged) rmSync(dir, { recursive: true, force: true });
  }
  const notIncluded = manifest.assetKeys.filter(
    (key) => !manifest.scans.some((scan) => scan.assetKey === key) && !hasAsset(options.store, key),
  );
  return { ok: true, documentOut: options.documentOut, installed: toInstall.map((s) => s.assetKey), alreadyPresent, notIncluded };
}
