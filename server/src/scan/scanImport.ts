/**
 * `scan_import` host transport (plant 10 TR-SCN-06, §2.A): hash the source, compute the content-addressed asset key, and when the store does
 * not hold it run `llull-compute cloud import` (NDJSON progress, timeout) into a temporary directory inside the store, then rename it into
 * place (atomic: a crash leaves no partial asset). The document is not touched; attach the asset with `attach_point_cloud`.
 * Proprietary formats are refused here, before any native work (VC-SCN-11).
 */

import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CloudManifest } from '@core/model/pointCloud';
import { isRecord } from '@lib/isRecord';
import { withJobFolder, type ComputeRunner } from '../native/computeJob';
import { nativeInstallHint } from '../native/nativeBinary';
import { assetDir, assetKey, DEFAULT_IMPORT_OPTIONS, hasAsset, importerVersion, type ImportOptions } from './scanStore';

export const DEFAULT_IMPORT_TIMEOUT_S = 3600;

/** Closed vendor formats (no public specification): `llull-cloud` refuses the same list. */
const PROPRIETARY = new Set(['rcp', 'rcs', 'fls', 'fws', 'lsproj', 'ptg', 'zfs', 'imp', 'x3a']);

export interface ScanImportParams {
  readonly path: string;
  readonly options: ImportOptions;
  readonly timeoutS?: number;
}

export interface ScanDeps {
  readonly runner: ComputeRunner;
  readonly store: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onProgress?: (line: string) => void;
}

export type ScanImportResult =
  | {
      readonly ok: true;
      readonly cached: boolean;
      readonly sourceSha256: string;
      readonly assetKey: string;
      readonly manifest: CloudManifest;
      readonly elapsedMs: number;
      readonly warnings: readonly { code: string; message: string }[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

const fail = (code: string, message: string): ScanImportResult => ({ ok: false, code, message });

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Import options from tool params (defaults filled in; they are part of the asset key). */
export function importOptionsOf(params: Readonly<Record<string, unknown>>): ImportOptions | string {
  const options: { -readonly [K in keyof ImportOptions]: ImportOptions[K] } = { ...DEFAULT_IMPORT_OPTIONS };
  const { format, sourceUnit, columns, applyStationPoses, checksum, maxPointsPerNode } = params;
  if (format !== undefined) {
    if (format !== 'xyz' && format !== 'pts' && format !== 'csv') return 'format must be xyz, pts or csv (binary formats are detected)';
    options.format = format;
  }
  if (sourceUnit !== undefined) {
    if (sourceUnit !== 'm' && sourceUnit !== 'mm' && sourceUnit !== 'cm' && sourceUnit !== 'ft' && sourceUnit !== 'in')
      return 'sourceUnit must be m, mm, cm, ft or in';
    options.sourceUnit = sourceUnit;
  }
  if (columns !== undefined) {
    if (typeof columns !== 'string' || !/^[xyzirgb_]+$/.test(columns)) return 'columns must use the letters x y z i r g b _';
    options.columns = columns;
  }
  if (applyStationPoses !== undefined) {
    if (typeof applyStationPoses !== 'boolean') return 'applyStationPoses must be true or false';
    options.applyStationPoses = applyStationPoses;
  }
  if (checksum !== undefined) {
    if (checksum !== 'all' && checksum !== 'sparse' && checksum !== 'none') return 'checksum must be all, sparse or none';
    options.checksum = checksum;
  }
  if (maxPointsPerNode !== undefined) {
    if (
      typeof maxPointsPerNode !== 'number' ||
      !Number.isInteger(maxPointsPerNode) ||
      maxPointsPerNode < 100 ||
      maxPointsPerNode > 1_000_000
    )
      return 'maxPointsPerNode must be an integer in [100, 1000000]';
    options.maxPointsPerNode = maxPointsPerNode;
  }
  return options;
}

function readManifest(dir: string): CloudManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return isRecord(value) && typeof value['assetKey'] === 'string' ? (value as unknown as CloudManifest) : null;
  } catch {
    return null;
  }
}

/**
 * @failure missing file -> SCN_FILE_NOT_FOUND; proprietary extension -> SCN_FORMAT_PROPRIETARY; no binary -> NATIVE_TOOL_MISSING; the job's
 *   own codes (SCN_E57_CHECKSUM, SCN_CLOUD_EMPTY, SCN_LAS_HEADER, …); timeout -> NATIVE_TIMEOUT. No asset is left behind on failure.
 */
export async function runScanImport(params: ScanImportParams, deps: ScanDeps): Promise<ScanImportResult> {
  const source = path.resolve(params.path);
  if (!existsSync(source) || !statSync(source).isFile()) return fail('SCN_FILE_NOT_FOUND', `no file ${source}`);
  const extension = path.extname(source).slice(1).toLowerCase();
  if (PROPRIETARY.has(extension))
    return fail(
      'SCN_FORMAT_PROPRIETARY',
      `.${extension} is a closed vendor format: export E57 (or LAS) from the vendor tool, e.g. ReCap -> Export -> E57`,
    );
  if (deps.runner.binary === null) return fail('NATIVE_TOOL_MISSING', nativeInstallHint('llull-compute'));
  const started = Date.now();
  const sourceSha256 = await sha256File(source);
  const key = assetKey(sourceSha256, importerVersion(await deps.runner.version()), params.options);
  const target = assetDir(deps.store, key);
  const cachedManifest = hasAsset(deps.store, key) ? readManifest(target) : null;
  if (cachedManifest !== null && cachedManifest.assetKey === key)
    return {
      ok: true,
      cached: true,
      sourceSha256,
      assetKey: key,
      manifest: cachedManifest,
      elapsedMs: Date.now() - started,
      warnings: cachedManifest.warnings,
    };
  mkdirSync(deps.store, { recursive: true });
  const output = mkdtempSync(path.join(deps.store, '.tmp-'));
  try {
    const job = { version: 1, source, sourceName: path.basename(source), sourceSha256, assetKey: key, output, options: params.options };
    const seconds = Math.min(86_400, Math.max(1, params.timeoutS ?? DEFAULT_IMPORT_TIMEOUT_S));
    const sink = deps.onProgress;
    const run = await withJobFolder(
      { 'job.json': JSON.stringify(job) },
      (folder) =>
        deps.runner.run(
          ['cloud', 'import'],
          folder,
          seconds * 1000,
          sink === undefined
            ? undefined
            : (event) => sink(`scan_import: ${String(event['message'])} (${String(event['step'])}/${String(event['total'])})`),
        ),
      deps.env,
    );
    if (!run.ok) return fail(run.code ?? 'NATIVE_JOB_FAILED', run.message ?? 'llull-compute cloud import failed');
    const manifest = readManifest(output);
    if (manifest === null || manifest.assetKey !== key)
      return fail('NATIVE_PROTOCOL', 'the import did not write a manifest for the expected asset key');
    if (hasAsset(deps.store, key)) rmSync(output, { recursive: true, force: true });
    else renameSync(output, target);
    return { ok: true, cached: false, sourceSha256, assetKey: key, manifest, elapsedMs: Date.now() - started, warnings: run.warnings };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
