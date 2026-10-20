/**
 * The point-cloud asset store (plant 10 TECHNICAL_SPEC §3.1): `<dir>/<assetKey>/{manifest.json, hierarchy.bin, nodes.bin, source.sha256}`.
 * The asset key is content addressed (TR-SCN-01): sha256 of `<sourceSha256>\n<importerVersion>\n<canonical JSON of the import options>`, so
 * an agent can compute it and a re-import of the same file with the same options is a no-op.
 * Environment: LLULL_SCAN_CACHE  directory (default ~/.llull/cache/pointcloud)
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

/** Layout version of the asset (`llull-cloud` `ASSET_VERSION`). */
const ASSET_VERSION = 1;

const KEY = /^[0-9a-f]{64}$/;

export const isAssetKey = (value: string): boolean => KEY.test(value);

export function scanCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_SCAN_CACHE'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'cache', 'pointcloud');
}

/** `llull-cloud@<version>/asset-<layout>` for an `llull-compute` of `version`. */
export const importerVersion = (computeVersion: string): string => `llull-cloud@${computeVersion}/asset-${ASSET_VERSION}`;

/** Import options with every default filled in (they are part of the key). */
export interface ImportOptions {
  readonly format?: 'xyz' | 'pts' | 'csv';
  readonly sourceUnit: 'm' | 'mm' | 'cm' | 'ft' | 'in';
  readonly columns: string;
  readonly applyStationPoses: boolean;
  readonly checksum: 'all' | 'sparse' | 'none';
  readonly maxPointsPerNode: number;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  sourceUnit: 'm',
  columns: 'xyz',
  applyStationPoses: true,
  checksum: 'all',
  maxPointsPerNode: 20_000,
};

export function assetKey(sourceSha256: string, version: string, options: ImportOptions): string {
  return sha256Hex(`${sourceSha256}\n${version}\n${canonicalJson(options)}`);
}

/** Directory of an asset (whether or not it exists). */
export const assetDir = (store: string, key: string): string => path.join(store, key);

/** Whether a complete asset is stored under `key`. */
export const hasAsset = (store: string, key: string): boolean =>
  isAssetKey(key) && ['manifest.json', 'hierarchy.bin', 'nodes.bin'].every((file) => existsSync(path.join(store, key, file)));

/** Keys of the stored assets (sorted). */
export function listAssets(store: string): string[] {
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((name) => isAssetKey(name) && hasAsset(store, name))
    .sort();
}
