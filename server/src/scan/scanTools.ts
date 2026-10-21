/**
 * The point-cloud host tools of the `llull` CLI (plant 10): `scan_import` (file -> content-addressed asset, never the document) and
 * `scan_list` (the assets of this machine's store). Run in-process for a local --doc and through `POST /exchange` for --app / --server.
 */

import type { CommandOutcome } from '@protocol/restProtocol';
import { isRecord } from '@lib/isRecord';
import { createComputeRunner } from '../native/computeJob';
import { AssetReader } from './assetReader';
import { importOptionsOf, runScanImport, type ScanDeps } from './scanImport';
import { assetDir, listAssets, scanCacheDir } from './scanStore';

const NAMES: ReadonlySet<string> = new Set(['scan_import', 'scan_list']);

export const isScanTool = (name: string): boolean => NAMES.has(name);

export function defaultScanDeps(env: NodeJS.ProcessEnv = process.env, onProgress?: (line: string) => void): ScanDeps {
  return { runner: createComputeRunner(env), store: scanCacheDir(env), env, ...(onProgress !== undefined ? { onProgress } : {}) };
}

const failure = (summary: string, code: string): CommandOutcome => ({
  summary,
  affected: [],
  isError: true,
  changed: false,
  data: { code },
});

/** Runs a scan tool; null for any other name. Never changes the document. */
export async function runScanTool(name: string, params: unknown, deps: ScanDeps): Promise<CommandOutcome | null> {
  if (!isScanTool(name)) return null;
  if (name === 'scan_list') {
    const assets = listAssets(deps.store).flatMap((key) => {
      const reader = AssetReader.open(assetDir(deps.store, key), key);
      return reader === null
        ? []
        : [
            {
              assetKey: key,
              sourceName: reader.manifest.sourceName,
              format: reader.manifest.format,
              pointCount: reader.manifest.pointCount,
            },
          ];
    });
    return {
      summary: `scan_list: ${assets.length} asset(s) in ${deps.store}.`,
      affected: [],
      isError: false,
      changed: false,
      data: { store: deps.store, assets },
    };
  }
  const args = isRecord(params) ? params : {};
  const file = args['path'];
  if (typeof file !== 'string' || file === '') return failure('scan_import: path is required.', 'SCN_PARAM_INVALID');
  const options = importOptionsOf(args);
  if (typeof options === 'string') return failure(`scan_import: ${options}.`, 'SCN_PARAM_INVALID');
  const timeoutS = typeof args['timeoutS'] === 'number' && Number.isFinite(args['timeoutS']) ? args['timeoutS'] : undefined;
  const result = await runScanImport({ path: file, options, ...(timeoutS !== undefined ? { timeoutS } : {}) }, deps);
  if (!result.ok) return failure(`scan_import: ${result.code} — ${result.message}`, result.code);
  const { manifest } = result;
  const warnings = result.warnings.map((w) => w.code);
  return {
    summary:
      `scan_import: ${manifest.sourceName} -> asset ${result.assetKey} (${manifest.pointCount} points, ${manifest.format}, ${manifest.scans.length} scan(s), ` +
      `${manifest.octree.nodeCount} octree nodes)${result.cached ? ' [cached]' : ''}${warnings.length > 0 ? ` warnings: ${warnings.join(', ')}` : ''}. ` +
      `Attach it: attach_point_cloud assetKey=${result.assetKey}`,
    affected: [],
    isError: false,
    changed: false,
    data: {
      sourceSha256: result.sourceSha256,
      assetKey: result.assetKey,
      cached: result.cached,
      elapsedMs: result.elapsedMs,
      manifest: {
        sourceName: manifest.sourceName,
        format: manifest.format,
        pointCount: manifest.pointCount,
        dropped: manifest.dropped,
        scans: manifest.scans.map((s) => ({ guid: s.guid, pointCount: s.pointCount, pose: s.pose, fields: s.fields })),
        bounds: manifest.bounds,
        centroid: manifest.centroid,
        quantum: manifest.quantum,
        attributes: manifest.attributes,
        ...(manifest.crs !== undefined ? { crs: manifest.crs } : {}),
        octree: manifest.octree,
        importerVersion: manifest.importerVersion,
        warnings: manifest.warnings,
      },
    },
  };
}
